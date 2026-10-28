package app.switchboard.mobile.runtime

import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.data.composer.ComposerDraftCoordinator
import app.switchboard.mobile.data.composer.ComposerDraftMutation
import app.switchboard.mobile.data.composer.ComposerFileUploader
import app.switchboard.mobile.data.composer.ComposerUploadResult
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerFiles
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.StagedAttachment
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class DurableComposerRuntime(
    private val coordinator: ComposerDraftCoordinator,
    private val outbox: OutboxRuntime,
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { task ->
        Thread(task, "switchboard-composer").apply { isDaemon = true }
    },
) : Closeable {
    val drafts = coordinator.drafts
    val queuedTurns: StateFlow<List<QueuedTurn>> = outbox.state
    private val mutableErrors = MutableStateFlow<Map<ComposerDraftKey, String>>(emptyMap())
    val errors = mutableErrors.asStateFlow()

    fun hydrate() {
        worker.execute { coordinator.hydrate() }
    }

    fun save(draft: ComposerDraft) = mutate(draft.key) { coordinator.save(draft) }

    fun addImages(key: ComposerDraftKey, sources: List<ComposerImageSource>) =
        mutate(key) { coordinator.addImages(key, sources) }

    /**
     * Attaches picked files: images are shrunk into draft storage, other files
     * are uploaded when [uploader] is set (the backend has
     * `attachment_upload_v1`) and refused otherwise. Each refusal is one line
     * in the composer's error area.
     */
    fun addAttachments(key: ComposerDraftKey, sources: List<ComposerImageSource>, uploader: ComposerFileUploader?) {
        worker.execute {
            val intake = ComposerFiles.sort(sources, uploads = uploader != null)
            val images = if (intake.images.isEmpty()) {
                ComposerDraftMutation.Success
            } else {
                coordinator.addImages(key, intake.images)
            }
            val lines = intake.refused + when (images) {
                ComposerDraftMutation.Success -> emptyList()
                is ComposerDraftMutation.Failure -> listOf(images.reason)
                is ComposerDraftMutation.PartlyAdded -> listOf(images.reason)
            }
            if (lines.isEmpty()) mutableErrors.value = mutableErrors.value - key else recordError(key, lines.joinToString("\n"))
            intake.files.forEach { source ->
                uploader?.upload(source) { result -> worker.execute { addUploaded(key, result) } }
            }
        }
    }

    /**
     * Attaches a large paste as `pasted-text-N.txt`. [onFailed] gets the
     * reason when it is not saved, so the caller can put the text back.
     */
    fun attachPastedText(key: ComposerDraftKey, text: String, uploader: ComposerFileUploader, onFailed: (String) -> Unit) {
        worker.execute {
            val labels = drafts.value[key]?.attachments.orEmpty().map(ComposerAttachment::displayName)
            val name = ComposerFiles.nextPastedTextName(labels)
            uploader.uploadText(name, text) { result ->
                worker.execute {
                    when (result) {
                        is ComposerUploadResult.Refused -> onFailed(result.line)
                        is ComposerUploadResult.Uploaded -> addUploaded(key, result)
                    }
                }
            }
        }
    }

    private fun addUploaded(key: ComposerDraftKey, result: ComposerUploadResult) {
        val line = when (result) {
            is ComposerUploadResult.Refused -> result.line
            is ComposerUploadResult.Uploaded -> {
                val attachment = ComposerFiles.attachment(UUID.randomUUID().toString(), result.file)
                (coordinator.addUploaded(key, listOf(attachment)) as? ComposerDraftMutation.Failure)?.reason ?: return
            }
        }
        // Keep the refusals of the same pick: each file is one line.
        recordError(key, listOfNotNull(errors.value[key], line).joinToString("\n"))
    }

    fun removeImage(key: ComposerDraftKey, attachmentId: String) =
        mutate(key) { coordinator.removeImage(key, attachmentId) }

    fun beginEdit(key: ComposerDraftKey, origin: String) {
        worker.execute {
            val turn = outbox.beginEdit(origin)
            if (turn == null || turn.connectionId != key.connectionId || turn.threadId != key.threadId) {
                if (turn != null) outbox.setEditing(origin, false)
                recordError(key, "Queued message is no longer available")
                return@execute
            }
            val result = coordinator.replaceWithImages(
                draft = ComposerDraft(
                    key = key,
                    text = turn.text,
                    runtimeMode = turn.runtimeMode,
                    editingOrigin = turn.origin,
                ),
                sources = turn.attachments.mapIndexed { index, attachment ->
                    ComposerImageSource(
                        contentUri = "",
                        mimeType = attachment.mimeType,
                        displayName = "Image ${index + 1}",
                        privateSourcePath = attachment.privateUri,
                    )
                },
            )
            if (result is ComposerDraftMutation.Failure) outbox.setEditing(origin, false)
            recordResult(key, result)
        }
    }

    /** Copies a withdrawn turn's images back into draft storage, on the caller's thread. */
    fun restageImages(
        attachments: List<StagedAttachment>,
        existing: List<ComposerAttachment>,
    ): ComposerAttachmentStageResult = coordinator.stageImages(
        sources = attachments.mapIndexed { index, attachment ->
            ComposerImageSource(
                contentUri = "",
                mimeType = attachment.mimeType,
                displayName = "Image ${existing.size + index + 1}",
                privateSourcePath = attachment.privateUri,
            )
        },
        existing = existing,
    )

    fun retry(origin: String) {
        worker.execute { outbox.retry(origin) }
    }

    fun dismiss(origin: String) {
        worker.execute { outbox.dismiss(origin) }
    }

    /**
     * A one-tap action's own turn (the compaction-offer banner's "Compact"),
     * sent through the same durable outbox as an ordinary send. Mirrors
     * `send(textOverride)` in ThreadScreen.tsx: it does not touch the saved
     * draft or its attachments, so the text the user was composing survives.
     */
    fun submitText(key: ComposerDraftKey, text: String, runtimeMode: String?) {
        worker.execute {
            val outgoing = OutgoingTurnDraft(
                connectionId = key.connectionId,
                threadId = key.threadId,
                text = text.trim(),
                attachments = emptyList(),
                runtimeMode = runtimeMode,
                createdAtMs = System.currentTimeMillis(),
            )
            when (val result = outbox.enqueue(outgoing)) {
                is EnqueueResult.AttachmentFailure -> recordError(key, result.reason)
                is EnqueueResult.StorageFailure -> recordError(key, result.reason)
                is EnqueueResult.Durable -> mutableErrors.value = mutableErrors.value - key
            }
        }
    }

    fun submitSavedDraft(key: ComposerDraftKey) {
        worker.execute {
            val draft = drafts.value[key] ?: return@execute
            val result = enqueue(draft)
            if (result is EnqueueResult.Durable) recordResult(key, coordinator.clear(key))
            if (result is EnqueueResult.AttachmentFailure) recordError(key, result.reason)
            if (result is EnqueueResult.StorageFailure) recordError(key, result.reason)
        }
    }

    fun clearBlocking(key: ComposerDraftKey): Boolean = try {
        val result = worker.submit<ComposerDraftMutation> { coordinator.clear(key) }.get()
        recordResult(key, result)
        result is ComposerDraftMutation.Success
    } catch (exception: Exception) {
        recordError(key, exception.message ?: "Saved draft could not be cleared")
        false
    }

    override fun close() {
        worker.shutdownNow()
    }

    private fun mutate(key: ComposerDraftKey, operation: () -> ComposerDraftMutation) {
        worker.execute { recordResult(key, operation()) }
    }

    private fun enqueue(draft: ComposerDraft): EnqueueResult {
        val outgoing = OutgoingTurnDraft(
            connectionId = draft.key.connectionId,
            threadId = draft.key.threadId,
            text = draft.text.trim(),
            attachments = draft.attachments.map { attachment ->
                AttachmentDraft(
                    sourceUri = "",
                    mimeType = attachment.mimeType,
                    privateSourcePath = attachment.privateUri,
                )
            },
            runtimeMode = draft.runtimeMode,
            createdAtMs = System.currentTimeMillis(),
        )
        return draft.editingOrigin?.let { outbox.replace(it, outgoing) } ?: outbox.enqueue(outgoing)
    }

    private fun recordResult(key: ComposerDraftKey, result: ComposerDraftMutation) {
        when (result) {
            ComposerDraftMutation.Success -> mutableErrors.value = mutableErrors.value - key
            is ComposerDraftMutation.Failure -> recordError(key, result.reason)
            is ComposerDraftMutation.PartlyAdded -> recordError(key, result.reason)
        }
    }

    private fun recordError(key: ComposerDraftKey, message: String) {
        mutableErrors.value = mutableErrors.value + (key to message)
    }
}
