package app.switchboard.mobile.runtime

import app.switchboard.mobile.data.composer.ComposerDraftCoordinator
import app.switchboard.mobile.data.composer.ComposerDraftMutation
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import java.io.Closeable
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
                    runtimeMode = turn.runtimeMode ?: "sandbox",
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

    fun retry(origin: String) {
        worker.execute { outbox.retry(origin) }
    }

    fun dismiss(origin: String) {
        worker.execute { outbox.dismiss(origin) }
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
        }
    }

    private fun recordError(key: ComposerDraftKey, message: String) {
        mutableErrors.value = mutableErrors.value + (key to message)
    }
}
