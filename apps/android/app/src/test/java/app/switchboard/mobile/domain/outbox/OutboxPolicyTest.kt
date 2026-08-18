package app.switchboard.mobile.domain.outbox

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxPolicyTest {
    @Test
    fun stableOriginAlsoDefinesTheOptimisticBubbleIdentity() {
        val identity = OutboxIdentity("origin-7")

        assertEquals("origin-7", identity.origin)
        assertEquals("remote_origin-7", identity.bubbleId)
    }

    @Test
    fun exponentialRetryStartsAtOneSecondAndCapsAtSixteenSeconds() {
        assertEquals(1_000, OutboxRetry.delayMs(1))
        assertEquals(2_000, OutboxRetry.delayMs(2))
        assertEquals(4_000, OutboxRetry.delayMs(3))
        assertEquals(16_000, OutboxRetry.delayMs(99))
    }

    @Test
    fun additiveResponseDecoderAcceptsLegacyAndCompletedBodiesLosslessly() {
        val legacy = SendResponseDecoder.decode(null)
        val completedRaw = obj(
            "accepted" to JsonBoolean(true),
            "duplicate" to JsonBoolean(true),
            "state" to JsonString("completed"),
            "future" to JsonString("kept"),
        )
        val completed = SendResponseDecoder.decode(completedRaw)

        assertTrue(legacy is SendOutcome.Accepted && legacy.receipt.legacy)
        assertTrue(completed is SendOutcome.Accepted)
        val receipt = (completed as SendOutcome.Accepted).receipt
        assertEquals(true, receipt.duplicate)
        assertEquals(JsonString("kept"), receipt.raw!!.values["future"])
    }

    @Test
    fun additiveResponseDecoderDistinguishesPendingAmbiguousAndContradictoryBodies() {
        val pending = SendResponseDecoder.decode(
            obj("accepted" to JsonBoolean(false), "duplicate" to JsonBoolean(false), "state" to JsonString("pending")),
        )
        val ambiguous = SendResponseDecoder.decode(
            obj("accepted" to JsonBoolean(false), "duplicate" to JsonBoolean(false), "state" to JsonString("ambiguous"), "reason" to JsonString("reservation uncertain")),
        )
        val contradictory = SendResponseDecoder.decode(
            obj("accepted" to JsonBoolean(true), "duplicate" to JsonBoolean(false), "state" to JsonString("pending")),
        )

        assertTrue(pending is SendOutcome.Pending)
        assertTrue(ambiguous is SendOutcome.Ambiguous)
        assertTrue(contradictory is SendOutcome.Ambiguous)
        assertTrue((contradictory as SendOutcome.Ambiguous).reason.contains("Contradictory"))
    }

    @Test
    fun commandSuccessIsIndependentFromAFailedFollowUpRefresh() {
        val result = OutboxFollowUpPolicy.afterCommand(
            OutboxOperationResult.Success("sent"),
        ) { OutboxOperationResult.Failure("refresh offline") }

        assertEquals("sent", (result.command as OutboxOperationResult.Success).value)
        assertTrue(result.followUp is OutboxOperationResult.Failure)

        var refreshes = 0
        val failed = OutboxFollowUpPolicy.afterCommand<String, String>(
            OutboxOperationResult.Failure("send failed"),
        ) {
            refreshes++
            OutboxOperationResult.Success("unused")
        }
        assertEquals(0, refreshes)
        assertNull(failed.followUp)
    }

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))
}
