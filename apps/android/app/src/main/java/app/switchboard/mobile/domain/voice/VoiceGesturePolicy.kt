package app.switchboard.mobile.domain.voice

enum class VoiceGestureOutcome {
    None,
    Locked,
    Cancelled,
}

object VoiceGesturePolicy {
    const val HoldMillis = 220L
    const val LockDistanceDp = 56f
    const val CancelDistanceDp = 72f

    fun isHold(durationMs: Long): Boolean = durationMs >= HoldMillis

    fun outcome(deltaX: Float, deltaY: Float): VoiceGestureOutcome {
        val upward = -deltaY
        val sideways = kotlin.math.abs(deltaX)
        return when {
            upward >= LockDistanceDp && upward >= sideways -> VoiceGestureOutcome.Locked
            sideways >= CancelDistanceDp && sideways > upward -> VoiceGestureOutcome.Cancelled
            else -> VoiceGestureOutcome.None
        }
    }
}
