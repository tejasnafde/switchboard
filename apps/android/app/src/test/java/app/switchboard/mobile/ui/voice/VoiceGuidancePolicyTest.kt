package app.switchboard.mobile.ui.voice

import app.switchboard.mobile.domain.voice.VoiceGestureOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceGuidancePolicyTest {
    @Test
    fun `idle microphone has no persistent guidance`() {
        assertNull(
            VoiceGuidancePolicy.message(
                pressed = false,
                holdStarted = false,
                locked = false,
                gesture = VoiceGestureOutcome.None,
            ),
        )
    }

    @Test
    fun `guidance only describes the active voice gesture`() {
        assertEquals(
            "Keep holding…",
            VoiceGuidancePolicy.message(true, false, false, VoiceGestureOutcome.None),
        )
        assertEquals(
            "Listening · release to stop",
            VoiceGuidancePolicy.message(true, true, false, VoiceGestureOutcome.None),
        )
        assertEquals(
            "Release to lock",
            VoiceGuidancePolicy.message(true, true, false, VoiceGestureOutcome.Locked),
        )
        assertEquals(
            "Listening · tap Stop mic",
            VoiceGuidancePolicy.message(false, false, true, VoiceGestureOutcome.None),
        )
    }
}
