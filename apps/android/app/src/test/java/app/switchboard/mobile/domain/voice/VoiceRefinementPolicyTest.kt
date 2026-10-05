package app.switchboard.mobile.domain.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceRefinementPolicyTest {
    @Test
    fun `unsafe capture skips refinement before backend or size checks`() {
        assertEquals(
            VoiceRefinementSkipReason.UnsafeCapture,
            VoiceRefinementPolicy.skipReason(
                safeCapture = false,
                backendAvailable = true,
                durationMs = 1_000,
                audioBytes = 32_000,
            ),
        )
    }

    @Test
    fun `refinement applies RN duration and decoded byte bounds`() {
        assertEquals(
            VoiceRefinementSkipReason.TooLong,
            VoiceRefinementPolicy.skipReason(
                safeCapture = true,
                backendAvailable = true,
                durationMs = VoiceRefinementPolicy.MaxDurationMs + 1,
                audioBytes = 32_000,
            ),
        )
        assertEquals(
            VoiceRefinementSkipReason.TooLarge,
            VoiceRefinementPolicy.skipReason(
                safeCapture = true,
                backendAvailable = true,
                durationMs = 1_000,
                audioBytes = VoiceRefinementPolicy.MaxAudioBytes + 1,
            ),
        )
        assertEquals(
            null,
            VoiceRefinementPolicy.skipReason(
                safeCapture = true,
                backendAvailable = true,
                durationMs = VoiceRefinementPolicy.MaxDurationMs,
                audioBytes = VoiceRefinementPolicy.MaxAudioBytes,
            ),
        )
    }
}
