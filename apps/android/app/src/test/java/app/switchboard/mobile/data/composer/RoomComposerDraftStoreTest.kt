package app.switchboard.mobile.data.composer

import app.switchboard.mobile.data.local.ComposerDraftAttachmentEntity
import app.switchboard.mobile.data.local.ComposerDraftDao
import app.switchboard.mobile.data.local.ComposerDraftWithAttachments
import app.switchboard.mobile.data.local.ThreadPreferenceEntity
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomComposerDraftStoreTest {
    @Test
    fun `text mode editing origin and attachment order round trip losslessly`() {
        val store = RoomComposerDraftStore(FakeComposerDraftDao())
        val draft = ComposerDraft(
            key = ComposerDraftKey("machine", "thread"),
            text = "continue",
            runtimeMode = "plan",
            attachments = listOf(
                ComposerAttachment("a", "/private/a", "image/png", "a.png"),
                ComposerAttachment("b", "/private/b", "image/jpeg", "b.jpg"),
            ),
            editingOrigin = "origin-1",
        )

        assertEquals(ComposerDraftStorageResult.Success, store.save(draft))

        assertEquals(ComposerDraftLoadResult.Success(listOf(draft)), store.load())
    }

    @Test
    fun `failed replacement does not expose a partially rewritten attachment list`() {
        val dao = FakeComposerDraftDao()
        val store = RoomComposerDraftStore(dao)
        val original = ComposerDraft(
            ComposerDraftKey("machine", "thread"),
            attachments = listOf(ComposerAttachment("a", "/private/a", null, "a")),
        )
        store.save(original)
        dao.failWrites = true

        val result = store.save(
            original.copy(
                attachments = listOf(ComposerAttachment("b", "/private/b", null, "b")),
            ),
        )

        assertTrue(result is ComposerDraftStorageResult.Failure)
        assertEquals(ComposerDraftLoadResult.Success(listOf(original)), store.load())
    }
}

private class FakeComposerDraftDao : ComposerDraftDao() {
    private val preferences = linkedMapOf<String, ThreadPreferenceEntity>()
    private val attachments = linkedMapOf<String, List<ComposerDraftAttachmentEntity>>()
    var failWrites = false

    override fun replace(
        preference: ThreadPreferenceEntity,
        rows: List<ComposerDraftAttachmentEntity>,
    ) {
        if (failWrites) error("disk full")
        preferences[preference.threadKey] = preference
        attachments[preference.threadKey] = rows.toList()
    }

    override fun insertPreference(preference: ThreadPreferenceEntity): Long = 1

    override fun updateComposerPreference(
        threadKey: String,
        mode: String?,
        draft: String?,
        touchedAt: Long,
        editingOrigin: String?,
    ): Int = 1

    override fun clearAttachments(threadKey: String) = Unit

    override fun insertAttachments(rows: List<ComposerDraftAttachmentEntity>) = Unit

    override fun clearComposerPreference(threadKey: String): Int = 1

    override fun delete(threadKey: String): Int {
        attachments.remove(threadKey)
        return if (preferences.remove(threadKey) != null) 1 else 0
    }

    override fun allWithAttachments(): List<ComposerDraftWithAttachments> =
        preferences.values.map { preference ->
            ComposerDraftWithAttachments(
                preference,
                attachments[preference.threadKey].orEmpty(),
            )
        }
}
