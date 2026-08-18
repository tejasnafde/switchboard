package app.switchboard.mobile.ui.voice

import app.switchboard.mobile.domain.voice.VoiceGestureOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoicePrimaryActionPolicyTest {
    @Test
    fun `locked dictation stop takes priority over a non-empty transcript`() {
        assertEquals(
            VoicePrimaryMode.StopDictation,
            VoicePrimaryActionPolicy.mode(
                canSend = true,
                agentRunning = true,
                listening = true,
                locked = true,
            ),
        )
    }

    @Test
    fun `send precedes agent interrupt while an editable message exists`() {
        assertEquals(
            VoicePrimaryMode.Send,
            VoicePrimaryActionPolicy.mode(
                canSend = true,
                agentRunning = true,
                listening = false,
                locked = false,
            ),
        )
        assertEquals(
            VoicePrimaryMode.StopAgent,
            VoicePrimaryActionPolicy.mode(
                canSend = false,
                agentRunning = true,
                listening = false,
                locked = false,
            ),
        )
    }

    @Test
    fun `empty idle composer exposes microphone`() {
        assertEquals(
            VoicePrimaryMode.Microphone,
            VoicePrimaryActionPolicy.mode(
                canSend = false,
                agentRunning = false,
                listening = false,
                locked = false,
            ),
        )
    }

    @Test
    fun `short microphone press does nothing while held release stops without sending`() {
        assertEquals(
            VoiceReleaseAction.None,
            VoicePrimaryActionPolicy.release(
                modeAtPress = VoicePrimaryMode.Microphone,
                holdStarted = false,
                gesture = VoiceGestureOutcome.None,
            ),
        )
        assertEquals(
            VoiceReleaseAction.StopDictation,
            VoicePrimaryActionPolicy.release(
                modeAtPress = VoicePrimaryMode.Microphone,
                holdStarted = true,
                gesture = VoiceGestureOutcome.None,
            ),
        )
    }

    @Test
    fun `held microphone release preserves lock and cancel semantics`() {
        assertEquals(
            VoiceReleaseAction.LockDictation,
            VoicePrimaryActionPolicy.release(
                VoicePrimaryMode.Microphone,
                holdStarted = true,
                VoiceGestureOutcome.Locked,
            ),
        )
        assertEquals(
            VoiceReleaseAction.CancelDictation,
            VoicePrimaryActionPolicy.release(
                VoicePrimaryMode.Microphone,
                holdStarted = true,
                VoiceGestureOutcome.Cancelled,
            ),
        )
    }

    @Test
    fun `tap composer toggles recognition only and never sends`() {
        assertEquals(
            VoiceTapAction.StartDictation,
            VoicePrimaryActionPolicy.tap(listening = false),
        )
        assertEquals(
            VoiceTapAction.StopDictation,
            VoicePrimaryActionPolicy.tap(listening = true),
        )
    }

    @Test
    fun `configuration replacement is not classified as app background`() {
        assertTrue(VoiceLifecyclePolicy.shouldStopForBackground(isChangingConfigurations = false))
        assertFalse(VoiceLifecyclePolicy.shouldStopForBackground(isChangingConfigurations = true))
    }
}
