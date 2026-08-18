package app.switchboard.mobile.domain.voice

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceRefinementPolicyTest {
    @Test
    fun `successful transport still parses backend domain rejection`() {
        val body = obj(
            "ok" to JsonBoolean(false),
            "error" to JsonString("whisper unavailable"),
        )

        assertEquals(
            VoiceRefinementResult.Rejected("whisper unavailable"),
            VoiceRefinementResponseDecoder.decode(body),
        )
    }

    @Test
    fun `accepted body requires the existing whisper response contract`() {
        val body = obj(
            "ok" to JsonBoolean(true),
            "text" to JsonString("useDictation.ts"),
            "provider" to JsonString("whisper"),
            "modelId" to JsonString("ggml-large-v3-turbo-q5_0.bin"),
        )

        assertEquals(
            VoiceRefinementResult.Accepted(
                text = "useDictation.ts",
                modelId = "ggml-large-v3-turbo-q5_0.bin",
            ),
            VoiceRefinementResponseDecoder.decode(body),
        )
    }

    @Test
    fun `malformed 2xx body is not treated as success`() {
        assertEquals(
            VoiceRefinementResult.Malformed("Malformed transcription response"),
            VoiceRefinementResponseDecoder.decode(obj("ok" to JsonBoolean(true))),
        )
    }

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

    private fun obj(vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(linkedMapOf(*fields))
}
