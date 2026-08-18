package app.switchboard.mobile.data.composer

import app.switchboard.mobile.data.local.ComposerDraftAttachmentEntity
import app.switchboard.mobile.data.local.ComposerDraftDao
import app.switchboard.mobile.data.local.ComposerDraftWithAttachments
import app.switchboard.mobile.data.local.ThreadPreferenceEntity
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey

object ComposerDraftEntityMapper {
    fun toRows(draft: ComposerDraft): ComposerDraftWithAttachments =
        ComposerDraftWithAttachments(
            preference = ThreadPreferenceEntity(
                threadKey = draft.key.storageKey,
                mode = draft.runtimeMode,
                model = null,
                draft = draft.text,
                touchedAt = System.currentTimeMillis(),
                editingOrigin = draft.editingOrigin,
            ),
            attachments = draft.attachments.mapIndexed { position, attachment ->
                ComposerDraftAttachmentEntity(
                    threadKey = draft.key.storageKey,
                    position = position,
                    attachmentId = attachment.id,
                    privatePath = attachment.privateUri,
                    mimeType = attachment.mimeType,
                    displayName = attachment.displayName,
                )
            },
        )

    fun toDomain(rows: ComposerDraftWithAttachments): ComposerDraft {
        val preference = rows.preference
        val attachments = rows.attachments.sortedBy(ComposerDraftAttachmentEntity::position)
        require(attachments.map(ComposerDraftAttachmentEntity::position) == attachments.indices.toList()) {
            "composer ${preference.threadKey} attachment positions are not contiguous"
        }
        require(attachments.all { it.threadKey == preference.threadKey }) {
            "composer ${preference.threadKey} contains attachments for another thread"
        }
        return ComposerDraft(
            key = ComposerDraftKey.parse(preference.threadKey),
            text = preference.draft.orEmpty(),
            runtimeMode = preference.mode ?: "sandbox",
            attachments = attachments.map { row ->
                ComposerAttachment(
                    id = row.attachmentId,
                    privateUri = row.privatePath,
                    mimeType = row.mimeType,
                    displayName = row.displayName,
                )
            },
            editingOrigin = preference.editingOrigin,
        )
    }
}

class RoomComposerDraftStore(
    private val dao: ComposerDraftDao,
) : ComposerDraftStore {
    override fun load(): ComposerDraftLoadResult = try {
        ComposerDraftLoadResult.Success(
            dao.allWithAttachments().map(ComposerDraftEntityMapper::toDomain),
        )
    } catch (exception: Exception) {
        ComposerDraftLoadResult.Failure(exception.message ?: "failed to load composer drafts")
    }

    override fun save(draft: ComposerDraft): ComposerDraftStorageResult = try {
        val rows = ComposerDraftEntityMapper.toRows(draft)
        dao.replace(rows.preference, rows.attachments)
        ComposerDraftStorageResult.Success
    } catch (exception: Exception) {
        ComposerDraftStorageResult.Failure(exception.message ?: "failed to save composer draft")
    }

    override fun delete(key: ComposerDraftKey): ComposerDraftStorageResult = try {
        dao.delete(key.storageKey)
        ComposerDraftStorageResult.Success
    } catch (exception: Exception) {
        ComposerDraftStorageResult.Failure(exception.message ?: "failed to delete composer draft")
    }
}
