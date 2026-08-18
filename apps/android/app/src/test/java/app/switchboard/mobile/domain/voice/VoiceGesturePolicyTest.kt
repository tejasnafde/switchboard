package app.switchboard.mobile.domain.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceGesturePolicyTest {
    @Test
    fun `thread mic starts only after the RN hold threshold`() {
        assertFalse(VoiceGesturePolicy.isHold(219))
        assertTrue(VoiceGesturePolicy.isHold(220))
    }

    @Test
    fun `dominant upward travel locks at 56 dp`() {
        assertEquals(VoiceGestureOutcome.None, VoiceGesturePolicy.outcome(0f, -55f))
        assertEquals(VoiceGestureOutcome.Locked, VoiceGesturePolicy.outcome(0f, -56f))
        assertEquals(VoiceGestureOutcome.Locked, VoiceGesturePolicy.outcome(20f, -80f))
    }

    @Test
    fun `dominant sideways travel cancels at 72 dp in either direction`() {
        assertEquals(VoiceGestureOutcome.None, VoiceGesturePolicy.outcome(71f, 0f))
        assertEquals(VoiceGestureOutcome.Cancelled, VoiceGesturePolicy.outcome(72f, 0f))
        assertEquals(VoiceGestureOutcome.Cancelled, VoiceGesturePolicy.outcome(-72f, 0f))
        assertEquals(VoiceGestureOutcome.Cancelled, VoiceGesturePolicy.outcome(-90f, -20f))
    }

    @Test
    fun `the dominant axis wins when both thresholds are crossed`() {
        assertEquals(VoiceGestureOutcome.Locked, VoiceGesturePolicy.outcome(72f, -82f))
        assertEquals(VoiceGestureOutcome.Cancelled, VoiceGesturePolicy.outcome(90f, -80f))
    }
}
