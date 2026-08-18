package app.switchboard.mobile.data.composer

import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerDraftCoordinatorTest {
    @Test
    fun `hydration restores text mode editing identity and attachment refs`() {
        val saved = draft(
            text = "continue here",
            mode = "plan",
            attachments = listOf(attachment("restored")),
            editingOrigin = "origin-7",
        )
        val fixture = Fixture(initial = listOf(saved))

        fixture.coordinator.hydrate()

        assertEquals(saved, fixture.coordinator.drafts.value.getValue(saved.key))
    }

    @Test
    fun `new images are privately staged before the draft row becomes visible`() {
        val fixture = Fixture()
        fixture.coordinator.hydrate()

        val result = fixture.coordinator.addImages(
            key(),
            listOf(ComposerImageSource("content://picked", "image/png", "picked.png")),
        )

        assertEquals(ComposerDraftMutation.Success, result)
        assertEquals(listOf("stage:content://picked", "save:machine:thread", "visible:machine:thread"), fixture.log)
        assertEquals("/private/drafts/picked", fixture.coordinator.drafts.value.getValue(key()).attachments.single().privateUri)
    }

    @Test
    fun `failed draft persistence discards only newly staged files and preserves prior state`() {
        val existing = draft(attachments = listOf(attachment("existing")))
        val fixture = Fixture(initial = listOf(existing))
        fixture.coordinator.hydrate()
        fixture.store.failSave = true

        val result = fixture.coordinator.addImages(
            key(),
            listOf(ComposerImageSource("content://new", "image/png", "new.png")),
        )

        assertTrue(result is ComposerDraftMutation.Failure)
        assertEquals(existing, fixture.coordinator.drafts.value.getValue(key()))
        assertTrue(fixture.log.contains("discard:/private/drafts/new"))
        assertFalse(fixture.log.contains("discard:/private/drafts/existing"))
    }

    @Test
    fun `removal and clear discard owned files only after the database commit`() {
        val existing = draft(attachments = listOf(attachment("one"), attachment("two")))
        val fixture = Fixture(initial = listOf(existing))
        fixture.coordinator.hydrate()

        fixture.coordinator.removeImage(key(), "one")
        fixture.coordinator.clear(key())

        assertTrue(fixture.log.indexOf("save:machine:thread") < fixture.log.indexOf("discard:/private/drafts/one"))
        assertTrue(fixture.log.indexOf("delete:machine:thread") < fixture.log.indexOf("discard:/private/drafts/two"))
        assertFalse(fixture.coordinator.drafts.value.containsKey(key()))
    }

    @Test
    fun `edit replacement keeps queued identity and changes attachment ownership after commit`() {
        val existing = draft(attachments = listOf(attachment("old-draft")))
        val fixture = Fixture(initial = listOf(existing))
        fixture.coordinator.hydrate()

        val result = fixture.coordinator.replaceWithImages(
            draft = draft(text = "edit me", mode = "plan", editingOrigin = "origin-7"),
            sources = listOf(
                ComposerImageSource(
                    contentUri = "",
                    mimeType = "image/png",
                    displayName = "queued.png",
                    privateSourcePath = "/private/outbox/queued",
                ),
            ),
        )

        assertEquals(ComposerDraftMutation.Success, result)
        val restored = fixture.coordinator.drafts.value.getValue(key())
        assertEquals("origin-7", restored.editingOrigin)
        assertEquals("edit me", restored.text)
        assertEquals(1, restored.attachments.size)
        assertTrue(
            fixture.log.indexOf("save:machine:thread") <
                fixture.log.indexOf("discard:/private/drafts/old-draft"),
        )
    }

    @Test
    fun `failed edit replacement preserves the existing draft and its files`() {
        val existing = draft(attachments = listOf(attachment("old-draft")))
        val fixture = Fixture(initial = listOf(existing))
        fixture.coordinator.hydrate()
        fixture.store.failSave = true

        val result = fixture.coordinator.replaceWithImages(
            draft = draft(text = "replacement", editingOrigin = "origin-7"),
            sources = listOf(ComposerImageSource("content://new", "image/png", "new.png")),
        )

        assertTrue(result is ComposerDraftMutation.Failure)
        assertEquals(existing, fixture.coordinator.drafts.value.getValue(key()))
        assertTrue(fixture.log.contains("discard:/private/drafts/new"))
        assertFalse(fixture.log.contains("discard:/private/drafts/old-draft"))
    }

    private fun key() = ComposerDraftKey("machine", "thread")

    private fun draft(
        text: String = "draft",
        mode: String = "sandbox",
        attachments: List<ComposerAttachment> = emptyList(),
        editingOrigin: String? = null,
    ) = ComposerDraft(key(), text, mode, attachments, editingOrigin)

    private fun attachment(id: String) = ComposerAttachment(
        id = id,
        privateUri = "/private/drafts/$id",
        mimeType = "image/png",
        displayName = "$id.png",
    )

    private class Fixture(initial: List<ComposerDraft> = emptyList()) {
        val log = mutableListOf<String>()
        val store = FakeStore(initial.associateBy(ComposerDraft::key).toMutableMap(), log)
        private val stager = FakeStager(log)
        val coordinator = ComposerDraftCoordinator(store, stager) { key ->
            log += "visible:${key.storageKey}"
        }
    }
}

private class FakeStore(
    private val rows: MutableMap<ComposerDraftKey, ComposerDraft>,
    private val log: MutableList<String>,
) : ComposerDraftStore {
    var failSave = false

    override fun load(): ComposerDraftLoadResult = ComposerDraftLoadResult.Success(rows.values.toList())

    override fun save(draft: ComposerDraft): ComposerDraftStorageResult {
        log += "save:${draft.key.storageKey}"
        if (failSave) return ComposerDraftStorageResult.Failure("disk full")
        rows[draft.key] = draft
        return ComposerDraftStorageResult.Success
    }

    override fun delete(key: ComposerDraftKey): ComposerDraftStorageResult {
        log += "delete:${key.storageKey}"
        rows.remove(key)
        return ComposerDraftStorageResult.Success
    }
}

private class FakeStager(
    private val log: MutableList<String>,
) : ComposerAttachmentStager {
    override fun stage(sources: List<ComposerImageSource>): ComposerAttachmentStageResult {
        sources.forEach { log += "stage:${it.privateSourcePath ?: it.contentUri}" }
        return ComposerAttachmentStageResult.Success(
            sources.map { source ->
                val sourceId = (source.privateSourcePath ?: source.contentUri).substringAfterLast('/')
                ComposerAttachment(
                    id = sourceId,
                    privateUri = "/private/drafts/$sourceId",
                    mimeType = source.mimeType,
                    displayName = source.displayName,
                )
            },
        )
    }

    override fun discard(attachments: List<ComposerAttachment>) {
        attachments.forEach { log += "discard:${it.privateUri}" }
    }
}
