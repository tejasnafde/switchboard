package app.switchboard.mobile.data.composer

import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerAttachmentPolicy
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
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
    data class Success(val attachments: List<ComposerAttachment>) : ComposerAttachmentStageResult
    data class Failure(val reason: String) : ComposerAttachmentStageResult
}

interface ComposerAttachmentStager {
    fun stage(sources: List<ComposerImageSource>): ComposerAttachmentStageResult
    fun discard(attachments: List<ComposerAttachment>)
}

sealed interface ComposerDraftMutation {
    data object Success : ComposerDraftMutation
    data class Failure(val reason: String) : ComposerDraftMutation
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

    @Synchronized
    fun addImages(
        key: ComposerDraftKey,
        sources: List<ComposerImageSource>,
    ): ComposerDraftMutation {
        val current = mutableDrafts.value[key] ?: ComposerDraft(key)
        val remaining = (ComposerAttachmentPolicy.MaxAttachments - current.attachments.size)
            .coerceAtLeast(0)
        if (remaining == 0 || sources.isEmpty()) return ComposerDraftMutation.Success
        val staged = when (val result = stager.stage(sources.take(remaining))) {
            is ComposerAttachmentStageResult.Failure -> return ComposerDraftMutation.Failure(result.reason)
            is ComposerAttachmentStageResult.Success -> result.attachments
        }
        val next = current.copy(attachments = current.attachments + staged)
        return when (val saved = store.save(next)) {
            ComposerDraftStorageResult.Success -> {
                mutableDrafts.value = mutableDrafts.value + (key to next)
                onVisible(key)
                ComposerDraftMutation.Success
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
        if (sources.size > ComposerAttachmentPolicy.MaxAttachments) {
            return ComposerDraftMutation.Failure("A draft supports at most 4 images")
        }
        val staged = when (val result = stager.stage(sources)) {
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
