package app.switchboard.mobile.domain.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as tests/unit/turn-delivery.test.ts and tests/unit/mobile-held-turns.test.ts. */
class TurnDeliveryPolicyTest {
    @Test
    fun onlyAnExplicitQueueDefaultQueues() {
        assertEquals(TurnDelivery.Queue, TurnDeliveryPolicy.parseFollowUpDefault("queue"))
        assertEquals(TurnDelivery.Steer, TurnDeliveryPolicy.parseFollowUpDefault("steer"))
        assertEquals(TurnDelivery.Steer, TurnDeliveryPolicy.parseFollowUpDefault(null))
        assertEquals(TurnDelivery.Steer, TurnDeliveryPolicy.parseFollowUpDefault("junk"))
    }

    @Test
    fun theAlternateSendDoesTheOtherOne() {
        assertEquals(TurnDelivery.Steer, TurnDeliveryPolicy.followUpDelivery(TurnDelivery.Steer, false))
        assertEquals(TurnDelivery.Queue, TurnDeliveryPolicy.followUpDelivery(TurnDelivery.Steer, true))
        assertEquals(TurnDelivery.Steer, TurnDeliveryPolicy.followUpDelivery(TurnDelivery.Queue, true))
    }

    @Test
    fun onlyAMidTurnSendThatShouldWaitAsksForQueue() {
        assertNull(TurnDeliveryPolicy.requestedDelivery("claude-code", running = false, TurnDelivery.Queue, flipped = false))
        assertNull(TurnDeliveryPolicy.requestedDelivery("claude-code", running = true, TurnDelivery.Steer, flipped = false))
        assertEquals(
            TurnDelivery.Queue,
            TurnDeliveryPolicy.requestedDelivery("codex", running = true, TurnDelivery.Steer, flipped = true),
        )
        assertEquals(
            TurnDelivery.Queue,
            TurnDeliveryPolicy.requestedDelivery("claude-code", running = true, TurnDelivery.Queue, flipped = false),
        )
        // OpenCode cannot take a message mid-turn, whatever the user picked.
        assertEquals(
            TurnDelivery.Queue,
            TurnDeliveryPolicy.requestedDelivery("opencode", running = true, TurnDelivery.Steer, flipped = false),
        )
    }

    @Test
    fun toggleReadsAsItAlwaysDidWithTheSteerDefault() {
        val steer = TurnDeliveryPolicy.queueToggle(TurnDelivery.Steer, flipped = false)
        assertFalse(steer.queues)
        assertEquals("Steering the running turn · tap to queue", steer.label)
        val flipped = TurnDeliveryPolicy.queueToggle(TurnDelivery.Steer, flipped = true)
        assertTrue(flipped.queues)
        assertEquals("Sends after this turn", flipped.label)
    }

    @Test
    fun toggleStartsQueuedWithTheQueueDefaultAndATapSteersOnce() {
        val queue = TurnDeliveryPolicy.queueToggle(TurnDelivery.Queue, flipped = false)
        assertTrue(queue.queues)
        assertEquals("Sends after this turn · tap to steer", queue.label)
        val flipped = TurnDeliveryPolicy.queueToggle(TurnDelivery.Queue, flipped = true)
        assertFalse(flipped.queues)
        assertEquals("Steering the running turn", flipped.label)
    }

    @Test
    fun findsTheHeldMessageForALiveRowAndAHistoryRow() {
        val held = setOf("remote_q")
        assertEquals("remote_q", TurnDeliveryPolicy.heldMessageId(held, "remote_q"))
        assertEquals("remote_q", TurnDeliveryPolicy.heldMessageId(held, "h-remote_q"))
        assertNull(TurnDeliveryPolicy.heldMessageId(held, "remote_other"))
        assertNull(TurnDeliveryPolicy.heldMessageId(emptySet(), "remote_q"))
    }

    @Test
    fun offersSendNowExceptWhereTheProviderCannotSteer() {
        assertEquals(HeldTurnActions(true, "Runs after this turn"), TurnDeliveryPolicy.heldTurnActions("claude"))
        val opencode = TurnDeliveryPolicy.heldTurnActions("opencode")
        assertFalse(opencode.canPromote)
        assertTrue(opencode.hint.contains("OpenCode"))
    }

    @Test
    fun placeholderFollowsTheChoice() {
        assertEquals("Steer the agent…", TurnDeliveryPolicy.runningPlaceholder("claude-code", queues = false))
        assertEquals("Queue a follow-up…", TurnDeliveryPolicy.runningPlaceholder("claude-code", queues = true))
        assertEquals("Queue a follow-up…", TurnDeliveryPolicy.runningPlaceholder("opencode", queues = false))
    }
}
