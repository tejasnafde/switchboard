package app.switchboard.mobile.domain.composer

import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import org.junit.Assert.assertEquals
import org.junit.Test

class ComposerDraftPolicyTest {
    @Test
    fun `delivery actions come from the persisted outbox state`() {
        assertEquals(
            setOf(OutboxUiAction.Edit),
            OutboxPresentationPolicy.actions(turn(OutboxDeliveryState.Pending)),
        )
        assertEquals(
            setOf(OutboxUiAction.Retry, OutboxUiAction.Abandon),
            OutboxPresentationPolicy.actions(
                turn(OutboxDeliveryState.Ambiguous("The server may have accepted this turn")),
            ),
        )
        assertEquals(
            setOf(OutboxUiAction.Retry, OutboxUiAction.Edit, OutboxUiAction.Dismiss),
            OutboxPresentationPolicy.actions(turn(OutboxDeliveryState.Terminal("Thread missing"))),
        )
    }

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
