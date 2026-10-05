package app.switchboard.mobile.domain.voice

sealed interface VoiceRefinementResult {
    data class Accepted(
        val text: String,
        val modelId: String,
    ) : VoiceRefinementResult

    data class Rejected(val reason: String) : VoiceRefinementResult

    data class Malformed(val reason: String) : VoiceRefinementResult
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
