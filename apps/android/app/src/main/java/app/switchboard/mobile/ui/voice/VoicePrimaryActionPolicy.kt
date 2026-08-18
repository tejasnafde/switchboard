package app.switchboard.mobile.ui.voice

import app.switchboard.mobile.domain.voice.VoiceGestureOutcome

enum class VoicePrimaryMode {
    Microphone,
    Send,
    StopAgent,
    StopDictation,
}

enum class VoiceReleaseAction {
    None,
    Send,
    StopAgent,
    StopDictation,
    LockDictation,
    CancelDictation,
}

enum class VoiceTapAction {
    StartDictation,
    StopDictation,
}

object VoicePrimaryActionPolicy {
    fun mode(
        canSend: Boolean,
        agentRunning: Boolean,
        listening: Boolean,
        locked: Boolean,
    ): VoicePrimaryMode = when {
        listening && locked -> VoicePrimaryMode.StopDictation
        canSend -> VoicePrimaryMode.Send
        agentRunning -> VoicePrimaryMode.StopAgent
        else -> VoicePrimaryMode.Microphone
    }

    fun release(
        modeAtPress: VoicePrimaryMode,
        holdStarted: Boolean,
        gesture: VoiceGestureOutcome,
    ): VoiceReleaseAction = when (modeAtPress) {
        VoicePrimaryMode.Send -> VoiceReleaseAction.Send
        VoicePrimaryMode.StopAgent -> VoiceReleaseAction.StopAgent
        VoicePrimaryMode.StopDictation -> VoiceReleaseAction.StopDictation
        VoicePrimaryMode.Microphone -> when {
            !holdStarted -> VoiceReleaseAction.None
            gesture == VoiceGestureOutcome.Locked -> VoiceReleaseAction.LockDictation
            gesture == VoiceGestureOutcome.Cancelled -> VoiceReleaseAction.CancelDictation
            else -> VoiceReleaseAction.StopDictation
        }
    }

    fun tap(listening: Boolean): VoiceTapAction =
        if (listening) VoiceTapAction.StopDictation else VoiceTapAction.StartDictation
}

object VoiceLifecyclePolicy {
    fun shouldStopForBackground(isChangingConfigurations: Boolean): Boolean =
        !isChangingConfigurations
}
