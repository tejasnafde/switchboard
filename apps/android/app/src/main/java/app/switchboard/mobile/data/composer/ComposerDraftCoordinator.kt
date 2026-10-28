package app.switchboard.mobile.data.composer

import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.composer.UploadedFile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface ComposerDraftStorageResult {
    data object Success : ComposerDraftStorageResult
    data class Failure(val reason: String) : ComposerDraftStorageResult
}

sealed interface ComposerDraftLoadResult {
    data class Success(val drafts: List<ComposerDraft>) : ComposerDraftLoadResult
    data class Failure(val reason: String) : ComposerDraftLoadResult
}

interface ComposerDraftStore {
    fun load(): ComposerDraftLoadResult
    fun save(draft: ComposerDraft): ComposerDraftStorageResult
    fun delete(key: ComposerDraftKey): ComposerDraftStorageResult
}

sealed interface ComposerAttachmentStageResult {
    /** [refused] names each picked image that was not attached, and why. */
    data class Success(
        val attachments: List<ComposerAttachment>,
        val refused: List<String> = emptyList(),
    ) : ComposerAttachmentStageResult
    data class Failure(val reason: String) : ComposerAttachmentStageResult
}

interface ComposerAttachmentStager {
    /** [existing] are the draft's attachments, which count against the message's image budget. */
    fun stage(sources: List<ComposerImageSource>, existing: List<ComposerAttachment>): ComposerAttachmentStageResult
    fun discard(attachments: List<ComposerAttachment>)
}

sealed interface ComposerUploadResult {
    data class Uploaded(val file: UploadedFile) : ComposerUploadResult

    /** One line naming the file and why it was not saved. */
    data class Refused(val line: String) : ComposerUploadResult
}

/** Saves a picked file or pasted text on the backend (`app:upload-attachment`). Calls back on any thread. */
interface ComposerFileUploader {
    fun upload(source: ComposerImageSource, callback: (ComposerUploadResult) -> Unit)

    fun uploadText(name: String, text: String, callback: (ComposerUploadResult) -> Unit)
}

sealed interface ComposerDraftMutation {
    data object Success : ComposerDraftMutation
    data class Failure(val reason: String) : ComposerDraftMutation

    /** The draft changed, but some picked images were not attached. */
    data class PartlyAdded(val reason: String) : ComposerDraftMutation
}

class ComposerDraftCoordinator(
    private val store: ComposerDraftStore,
    private val stager: ComposerAttachmentStager,
    private val onVisible: (ComposerDraftKey) -> Unit = {},
) {
    private val mutableDrafts = MutableStateFlow<Map<ComposerDraftKey, ComposerDraft>>(emptyMap())
    val drafts = mutableDrafts.asStateFlow()

    @Synchronized
    fun hydrate(): ComposerDraftLoadResult {
        val result = store.load()
        if (result is ComposerDraftLoadResult.Success) {
            mutableDrafts.value = result.drafts.associateBy(ComposerDraft::key)
        }
        return result
    }

    @Synchronized
    fun save(draft: ComposerDraft): ComposerDraftMutation = when (val result = store.save(draft)) {
        ComposerDraftStorageResult.Success -> {
            mutableDrafts.value = mutableDrafts.value + (draft.key to draft)
            onVisible(draft.key)
            ComposerDraftMutation.Success
        }
        is ComposerDraftStorageResult.Failure -> ComposerDraftMutation.Failure(result.reason)
    }

    /**
     * Saves a text or mode edit. The attachments stay the stored ones, read
     * under this lock: the caller's copy can predate a file the worker added.
     */
    @Synchronized
    fun saveText(draft: ComposerDraft): ComposerDraftMutation =
        save(draft.copy(attachments = mutableDrafts.value[draft.key]?.attachments.orEmpty()))

    @Synchronized
    fun addImages(
        key: ComposerDraftKey,
        sources: List<ComposerImageSource>,
    ): ComposerDraftMutation {
        val current = mutableDrafts.value[key] ?: ComposerDraft(key)
        if (sources.isEmpty()) return ComposerDraftMutation.Success
        val result = when (val stagedResult = stager.stage(sources, current.attachments)) {
            is ComposerAttachmentStageResult.Failure -> return ComposerDraftMutation.Failure(stagedResult.reason)
            is ComposerAttachmentStageResult.Success -> stagedResult
        }
        val staged = result.attachments
        val refused = if (result.refused.isEmpty()) {
            ComposerDraftMutation.Success
        } else {
            ComposerDraftMutation.PartlyAdded(result.refused.joinToString("\n"))
        }
        if (staged.isEmpty()) return refused
        val next = current.copy(attachments = current.attachments + staged)
        return when (val saved = store.save(next)) {
            ComposerDraftStorageResult.Success -> {
                mutableDrafts.value = mutableDrafts.value + (key to next)
                onVisible(key)
                refused
            }
            is ComposerDraftStorageResult.Failure -> {
                stager.discard(staged)
                ComposerDraftMutation.Failure(saved.reason)
            }
        }
    }

    @Synchronized
    fun replaceWithImages(
        draft: ComposerDraft,
        sources: List<ComposerImageSource>,
    ): ComposerDraftMutation {
        val previous = mutableDrafts.value[draft.key]
        val staged = when (val result = stager.stage(sources, emptyList())) {
            is ComposerAttachmentStageResult.Failure -> return ComposerDraftMutation.Failure(result.reason)
            is ComposerAttachmentStageResult.Success -> result.attachments
        }
        val replacement = draft.copy(attachments = staged)
        return when (val saved = store.save(replacement)) {
            ComposerDraftStorageResult.Success -> {
                mutableDrafts.value = mutableDrafts.value + (draft.key to replacement)
                stager.discard(previous?.attachments.orEmpty())
                onVisible(draft.key)
                ComposerDraftMutation.Success
            }
            is ComposerDraftStorageResult.Failure -> {
                stager.discard(staged)
                ComposerDraftMutation.Failure(saved.reason)
            }
        }
    }

    /** Adds files already saved on the backend to the draft. */
    @Synchronized
    fun addUploaded(key: ComposerDraftKey, attachments: List<ComposerAttachment>): ComposerDraftMutation {
        if (attachments.isEmpty()) return ComposerDraftMutation.Success
        val current = mutableDrafts.value[key] ?: ComposerDraft(key)
        return save(current.copy(attachments = current.attachments + attachments))
    }

    /** Copies images into draft storage without saving a draft; the caller saves them with one. */
    fun stageImages(
        sources: List<ComposerImageSource>,
        existing: List<ComposerAttachment>,
    ): ComposerAttachmentStageResult = stager.stage(sources, existing)

    @Synchronized
    fun removeImage(key: ComposerDraftKey, attachmentId: String): ComposerDraftMutation {
        val current = mutableDrafts.value[key] ?: return ComposerDraftMutation.Success
        val removed = current.attachments.firstOrNull { it.id == attachmentId }
            ?: return ComposerDraftMutation.Success
        val next = current.copy(attachments = current.attachments.filterNot { it.id == attachmentId })
        return when (val saved = store.save(next)) {
            ComposerDraftStorageResult.Success -> {
                mutableDrafts.value = mutableDrafts.value + (key to next)
                stager.discard(listOf(removed))
                onVisible(key)
                ComposerDraftMutation.Success
            }
            is ComposerDraftStorageResult.Failure -> ComposerDraftMutation.Failure(saved.reason)
        }
    }

    @Synchronized
    fun clear(key: ComposerDraftKey): ComposerDraftMutation {
        val current = mutableDrafts.value[key] ?: return ComposerDraftMutation.Success
        return when (val deleted = store.delete(key)) {
            ComposerDraftStorageResult.Success -> {
                mutableDrafts.value = mutableDrafts.value - key
                stager.discard(current.attachments)
                onVisible(key)
                ComposerDraftMutation.Success
            }
            is ComposerDraftStorageResult.Failure -> ComposerDraftMutation.Failure(deleted.reason)
        }
    }
}
