package app.switchboard.mobile.platform.voice

import android.speech.SpeechRecognizer
import app.switchboard.mobile.domain.voice.VoicePermissionDecision
import app.switchboard.mobile.domain.voice.VoiceRecognitionError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidVoicePlatformPolicyTest {
    @Test
    fun `permission result distinguishes retryable and permanent denial`() {
        assertEquals(
            VoicePermissionDecision.Granted,
            AndroidVoicePermissionPolicy.result(granted = true, canAskAgain = false),
        )
        assertEquals(
            VoicePermissionDecision.Denied(canAskAgain = true),
            AndroidVoicePermissionPolicy.result(granted = false, canAskAgain = true),
        )
        assertEquals(
            VoicePermissionDecision.Denied(canAskAgain = false),
            AndroidVoicePermissionPolicy.result(granted = false, canAskAgain = false),
        )
    }

    @Test
    fun `framework speech errors map to stable domain errors`() {
        assertEquals(
            VoiceRecognitionError.PermissionDenied,
            AndroidSpeechErrorPolicy.map(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS),
        )
        assertEquals(
            VoiceRecognitionError.NoSpeech,
            AndroidSpeechErrorPolicy.map(SpeechRecognizer.ERROR_NO_MATCH),
        )
        assertEquals(
            VoiceRecognitionError.ServiceUnavailable,
            AndroidSpeechErrorPolicy.map(SpeechRecognizer.ERROR_SERVER_DISCONNECTED),
        )
        assertEquals(
            VoiceRecognitionError.Other,
            AndroidSpeechErrorPolicy.map(Int.MAX_VALUE),
        )
    }

    @Test
    fun `recognizer intent policy preserves RN partial and silence behavior`() {
        val config = AndroidSpeechIntentPolicy.config("en-IN")

        assertEquals("en-IN", config.locale)
        assertTrue(config.partialResults)
        assertEquals(4_000L, config.completeSilenceMs)
        assertEquals(4_000L, config.possiblyCompleteSilenceMs)
    }

    @Test
    fun `default safe capture never claims microphone audio`() {
        val capture = UnavailableSafeVoiceAudioCapture

        assertFalse(capture.available)
        assertNull(capture.finish())
        capture.cancel()
        capture.close()
    }
}
