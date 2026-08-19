package app.switchboard.mobile.ui.voice

import app.switchboard.mobile.domain.voice.VoiceGestureOutcome

object VoiceGuidancePolicy {
    fun message(
        pressed: Boolean,
        holdStarted: Boolean,
        locked: Boolean,
        gesture: VoiceGestureOutcome,
    ): String? = when {
        gesture == VoiceGestureOutcome.Cancelled -> "Release to cancel"
        gesture == VoiceGestureOutcome.Locked -> "Release to lock"
        locked -> "Listening · tap Stop mic"
        pressed && holdStarted -> "Listening · release to stop"
        pressed -> "Keep holding…"
        else -> null
    }
}
