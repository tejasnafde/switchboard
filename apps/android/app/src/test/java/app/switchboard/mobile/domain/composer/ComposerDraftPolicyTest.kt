package app.switchboard.mobile.domain.composer

import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerDraftPolicyTest {
    @Test
    fun `selection keeps restored plus new images regardless of count`() {
        val restored = listOf(attachment("a"), attachment("b"), attachment("c"))
        val result = ComposerAttachmentPolicy.select(
            existing = restored,
            candidates = listOf(attachment("d"), attachment("e")),
        )

        assertEquals(listOf("a", "b", "c", "d", "e"), result.attachments.map { it.id })
        assertTrue(result.rejected.isEmpty())
    }

    @Test
    fun `image only draft is sendable but empty draft is not`() {
        assertFalse(ComposerDraftPolicy.canSend(ComposerDraft(key(), text = "   ")))
        assertTrue(
            ComposerDraftPolicy.canSend(
                ComposerDraft(key(), text = "", attachments = listOf(attachment("image"))),
            ),
        )
    }

    @Test
    fun `delivery actions come from the persisted outbox state`() {
        assertEquals(
            setOf(OutboxUiAction.Edit),
            OutboxPresentationPolicy.actions(turn(OutboxDeliveryState.Pending)),
        )
        assertEquals(
            setOf(OutboxUiAction.Retry),
            OutboxPresentationPolicy.actions(
                turn(OutboxDeliveryState.Ambiguous("The server may have accepted this turn")),
            ),
        )
        assertEquals(
            setOf(OutboxUiAction.Retry, OutboxUiAction.Edit, OutboxUiAction.Dismiss),
            OutboxPresentationPolicy.actions(turn(OutboxDeliveryState.Terminal("Thread missing"))),
        )
    }

    private fun key() = ComposerDraftKey("machine", "thread")

    private fun attachment(id: String) = ComposerAttachment(
        id = id,
        privateUri = "/private/drafts/$id",
        mimeType = "image/png",
        displayName = "$id.png",
    )

    private fun turn(state: OutboxDeliveryState) = QueuedTurn(
        connectionId = "machine",
        threadId = "thread",
        origin = "origin",
        bubbleId = "remote_origin",
        text = "hello",
        attachments = emptyList(),
        runtimeMode = "sandbox",
        createdAtMs = 1,
        attempts = 0,
        nextAttemptAtMs = 0,
        deliveryState = state,
    )
}
