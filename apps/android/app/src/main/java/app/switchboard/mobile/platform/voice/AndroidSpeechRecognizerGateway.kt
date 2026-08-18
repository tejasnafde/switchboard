package app.switchboard.mobile.platform.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import app.switchboard.mobile.domain.voice.VoiceCapturedAudio
import app.switchboard.mobile.domain.voice.VoiceRecognitionError
import app.switchboard.mobile.domain.voice.VoiceRecognitionListener
import app.switchboard.mobile.domain.voice.VoiceRecognitionSession
import app.switchboard.mobile.domain.voice.VoiceRecognitionStartResult
import app.switchboard.mobile.domain.voice.VoiceRecognizerGateway
import java.io.Closeable
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

data class AndroidSpeechIntentConfig(
    val locale: String,
    val partialResults: Boolean,
    val completeSilenceMs: Long,
    val possiblyCompleteSilenceMs: Long,
)

object AndroidSpeechIntentPolicy {
    fun config(locale: String): AndroidSpeechIntentConfig = AndroidSpeechIntentConfig(
        locale = locale.ifBlank { "en-US" },
        partialResults = true,
        completeSilenceMs = 4_000,
        possiblyCompleteSilenceMs = 4_000,
    )
}

object AndroidSpeechErrorPolicy {
    fun map(error: Int): VoiceRecognitionError = when (error) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> VoiceRecognitionError.PermissionDenied
        SpeechRecognizer.ERROR_NO_MATCH,
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
        -> VoiceRecognitionError.NoSpeech

        SpeechRecognizer.ERROR_CLIENT -> VoiceRecognitionError.Aborted
        SpeechRecognizer.ERROR_NETWORK,
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
        SpeechRecognizer.ERROR_SERVER,
        SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
        -> VoiceRecognitionError.ServiceUnavailable

        else -> VoiceRecognitionError.Other
    }
}

/**
 * Audio is available only when a recognizer-specific implementation has
 * established one shared source. This seam must not open a second microphone.
 */
interface SafeVoiceAudioCapture : Closeable {
    val available: Boolean
    fun finish(): VoiceCapturedAudio?
    fun cancel()
}

data object UnavailableSafeVoiceAudioCapture : SafeVoiceAudioCapture {
    override val available: Boolean = false
    override fun finish(): VoiceCapturedAudio? = null
    override fun cancel() = Unit
    override fun close() = Unit
}

fun interface SafeVoiceAudioCaptureProvider {
    fun attachTo(recognizer: SpeechRecognizer): SafeVoiceAudioCapture
}

class AndroidSpeechRecognizerGateway(
    context: Context,
    private val locale: () -> String = { Locale.getDefault().toLanguageTag() },
    private val sharedCapture: SafeVoiceAudioCaptureProvider =
        SafeVoiceAudioCaptureProvider { UnavailableSafeVoiceAudioCapture },
) : VoiceRecognizerGateway {
    private val applicationContext = context.applicationContext

    override fun isAvailable(): Boolean = runCatching {
        SpeechRecognizer.isRecognitionAvailable(applicationContext)
    }.getOrDefault(false)

    override fun start(
        sessionToken: Long,
        listener: VoiceRecognitionListener,
    ): VoiceRecognitionStartResult {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            return VoiceRecognitionStartResult.Failed("Voice recognition must start on the main thread.")
        }
        if (!isAvailable()) {
            return VoiceRecognitionStartResult.Failed("Voice recognition is unavailable.")
        }
        val recognizer = try {
            SpeechRecognizer.createSpeechRecognizer(applicationContext)
        } catch (error: RuntimeException) {
            return VoiceRecognitionStartResult.Failed(
                error.message ?: "Voice input failed to start.",
            )
        }
        val capture = runCatching { sharedCapture.attachTo(recognizer) }
            .getOrDefault(UnavailableSafeVoiceAudioCapture)
        val session = AndroidVoiceRecognitionSession(recognizer, capture)
        return try {
            recognizer.setRecognitionListener(AndroidRecognitionListener(listener))
            recognizer.startListening(recognitionIntent(AndroidSpeechIntentPolicy.config(locale())))
            VoiceRecognitionStartResult.Started(session)
        } catch (error: RuntimeException) {
            session.cancel()
            session.close()
            VoiceRecognitionStartResult.Failed(error.message ?: "Voice input failed to start.")
        }
    }

    private fun recognitionIntent(config: AndroidSpeechIntentConfig): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, config.locale)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, config.partialResults)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                config.completeSilenceMs,
            )
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                config.possiblyCompleteSilenceMs,
            )
        }
}

private class AndroidVoiceRecognitionSession(
    private val recognizer: SpeechRecognizer,
    private val capture: SafeVoiceAudioCapture,
) : VoiceRecognitionSession {
    private val closed = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)

    override fun stop() = onMain { recognizer.stopListening() }

    override fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        capture.cancel()
        onMain { recognizer.cancel() }
    }

    override fun finishSafeAudio(): VoiceCapturedAudio? =
        if (capture.available) runCatching(capture::finish).getOrNull() else null

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching(capture::close)
        onMain {
            // setRecognitionListener requires a non-null listener. destroy() is
            // Android's supported listener/resource teardown operation.
            recognizer.destroy()
        }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runCatching(block)
        } else {
            android.os.Handler(Looper.getMainLooper()).post { runCatching(block) }
        }
    }
}

private class AndroidRecognitionListener(
    private val listener: VoiceRecognitionListener,
) : RecognitionListener {
    override fun onPartialResults(partialResults: Bundle?) {
        firstTranscript(partialResults)?.let(listener::onPartial)
    }

    override fun onResults(results: Bundle?) {
        listener.onFinal(firstTranscript(results).orEmpty())
        listener.onEnd()
    }

    override fun onError(error: Int) {
        listener.onError(AndroidSpeechErrorPolicy.map(error))
    }

    override fun onReadyForSpeech(params: Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onEvent(eventType: Int, params: Bundle?) = Unit

    private fun firstTranscript(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
}
