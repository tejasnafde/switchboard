package app.switchboard.mobile.domain.voice

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

sealed interface VoiceRefinementResult {
    data class Accepted(
        val text: String,
        val modelId: String,
    ) : VoiceRefinementResult

    data class Rejected(val reason: String) : VoiceRefinementResult

    data class Malformed(val reason: String) : VoiceRefinementResult
}

object VoiceRefinementResponseDecoder {
    fun decode(value: JsonValue?): VoiceRefinementResult {
        val body = value as? JsonObject
            ?: return VoiceRefinementResult.Malformed(MalformedMessage)
        val ok = (body.values["ok"] as? JsonBoolean)?.value
            ?: return VoiceRefinementResult.Malformed(MalformedMessage)
        if (!ok) {
            val reason = (body.values["error"] as? JsonString)?.value
                ?.takeIf(String::isNotBlank)
                ?: "Backend rejected transcription"
            return VoiceRefinementResult.Rejected(reason)
        }
        val text = (body.values["text"] as? JsonString)?.value
            ?: return VoiceRefinementResult.Malformed(MalformedMessage)
        val provider = (body.values["provider"] as? JsonString)?.value
        val modelId = (body.values["modelId"] as? JsonString)?.value
            ?.takeIf(String::isNotBlank)
        if (provider != "whisper" || modelId == null) {
            return VoiceRefinementResult.Malformed(MalformedMessage)
        }
        return VoiceRefinementResult.Accepted(text, modelId)
    }

    private const val MalformedMessage = "Malformed transcription response"
}

enum class VoiceRefinementSkipReason {
    UnsafeCapture,
    NoBackend,
    Empty,
    TooLong,
    TooLarge,
}

object VoiceRefinementPolicy {
    const val MaxDurationMs = 2 * 60 * 1_000L
    const val MaxAudioBytes = 25 * 1_024 * 1_024L
    const val TimeoutMs = 30_000L

    fun skipReason(
        safeCapture: Boolean,
        backendAvailable: Boolean,
        durationMs: Long,
        audioBytes: Long,
    ): VoiceRefinementSkipReason? = when {
        !safeCapture -> VoiceRefinementSkipReason.UnsafeCapture
        !backendAvailable -> VoiceRefinementSkipReason.NoBackend
        audioBytes <= 0 -> VoiceRefinementSkipReason.Empty
        durationMs > MaxDurationMs -> VoiceRefinementSkipReason.TooLong
        audioBytes > MaxAudioBytes -> VoiceRefinementSkipReason.TooLarge
        else -> null
    }
}
