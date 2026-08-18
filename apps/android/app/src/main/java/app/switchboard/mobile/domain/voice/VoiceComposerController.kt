package app.switchboard.mobile.domain.voice

import java.io.Closeable

sealed interface VoicePermissionDecision {
    data object Granted : VoicePermissionDecision
    data class Denied(val canAskAgain: Boolean) : VoicePermissionDecision
}

interface VoicePermissionGateway {
    fun request(callback: (VoicePermissionDecision) -> Unit)
    fun openSettings(): Boolean
}

interface VoiceRecognitionListener {
    fun onPartial(transcript: String)
    fun onFinal(transcript: String)
    fun onEnd()
    fun onError(error: VoiceRecognitionError)
}

enum class VoiceRecognitionError {
    Aborted,
    NoSpeech,
    PermissionDenied,
    ServiceUnavailable,
    Other,
}

sealed interface VoiceRecognitionStartResult {
    data class Started(val session: VoiceRecognitionSession) : VoiceRecognitionStartResult
    data class Failed(val reason: String) : VoiceRecognitionStartResult
}

interface VoiceRecognizerGateway {
    fun isAvailable(): Boolean

    fun start(
        sessionToken: Long,
        listener: VoiceRecognitionListener,
    ): VoiceRecognitionStartResult
}

interface VoiceRecognitionSession : Closeable {
    fun stop()
    fun cancel()

    /**
     * Returns audio only when the recognizer established a proven shared
     * capture source. Implementations must never open a second microphone here.
     */
    fun finishSafeAudio(): VoiceCapturedAudio?
}

data class VoiceCapturedAudio(
    val bytes: ByteArray,
    val mimeType: String,
    val durationMs: Long,
)

data class VoiceRefinementRequest(
    val audio: ByteArray,
    val mimeType: String,
    val projectPath: String,
    val durationMs: Long,
)

fun interface VoiceCancelable {
    fun cancel()
}

interface VoiceTranscriptRefiner {
    val available: Boolean

    fun transcribe(
        request: VoiceRefinementRequest,
        callback: (VoiceRefinementResult) -> Unit,
    ): VoiceCancelable
}

fun interface VoiceScheduler {
    fun schedule(delayMs: Long, block: () -> Unit): VoiceCancelable
}

enum class VoiceNoticeAction {
    RetryPermission,
    OpenSettings,
}

data class VoiceNotice(
    val message: String,
    val action: VoiceNoticeAction? = null,
)

data class VoiceComposerControllerState(
    val session: VoiceSessionState,
    val available: Boolean,
    val starting: Boolean = false,
    val notice: VoiceNotice? = null,
)

class VoiceComposerController(
    initialDraft: String,
    private val permission: VoicePermissionGateway,
    private val recognizer: VoiceRecognizerGateway,
    private val refiner: VoiceTranscriptRefiner,
    private val scheduler: VoiceScheduler,
    private val projectPath: String,
    private val onDraft: (String) -> Unit,
    private val onState: (VoiceComposerControllerState) -> Unit = {},
) : Closeable {
    var state = VoiceComposerControllerState(
        session = VoiceSessionState(VoiceDraft(initialDraft, revision = 0)),
        available = runCatching(recognizer::isAvailable).getOrDefault(false),
    )
        private set

    private var nextSessionToken = 0L
    private var pendingStartToken: Long? = null
    private var activeSession: VoiceRecognitionSession? = null
    private var refinementCall: VoiceCancelable? = null
    private var refinementTimeout: VoiceCancelable? = null
    private var pendingAudio: VoiceCapturedAudio? = null
    private var closed = false

    fun start() {
        val token = synchronized(this) {
            if (closed || state.starting || state.session.listening || state.session.refining) return
            val available = runCatching(recognizer::isAvailable).getOrDefault(false)
            if (!available) {
                publish(state.copy(available = false, notice = VoiceNotice("Voice recognition is unavailable.")))
                return
            }
            (++nextSessionToken).also {
                pendingStartToken = it
                publish(state.copy(available = true, starting = true, notice = null))
            }
        }
        permission.request { decision -> onPermission(token, decision) }
    }

    fun stop() {
        val token = synchronized(this) { state.session.sessionToken } ?: return
        dispatch(VoiceSessionEvent.Stop(token))
    }

    fun cancel() {
        val token = synchronized(this) { state.session.sessionToken } ?: return
        dispatch(VoiceSessionEvent.Cancel(token))
    }

    fun lock() {
        val token = synchronized(this) { state.session.sessionToken } ?: return
        dispatch(VoiceSessionEvent.Lock(token))
    }

    fun userEdited(text: String) {
        dispatch(VoiceSessionEvent.UserEdited(text))
    }

    fun onBackground() {
        synchronized(this) { pendingStartToken = null }
        dispatch(VoiceSessionEvent.Dispose)
        synchronized(this) {
            if (!closed) publish(state.copy(starting = false))
        }
    }

    fun openNoticeAction(): Boolean = when (synchronized(this) { state.notice?.action }) {
        VoiceNoticeAction.OpenSettings -> permission.openSettings()
        VoiceNoticeAction.RetryPermission -> {
            start()
            true
        }
        null -> false
    }

    override fun close() {
        synchronized(this) {
            if (closed) return
            closed = true
            pendingStartToken = null
        }
        dispatch(VoiceSessionEvent.Dispose)
        synchronized(this) { publish(state.copy(starting = false)) }
    }

    private fun onPermission(token: Long, decision: VoicePermissionDecision) {
        synchronized(this) {
            if (closed || pendingStartToken != token) return
            pendingStartToken = null
            when (decision) {
                VoicePermissionDecision.Granted -> startRecognizer(token)
                is VoicePermissionDecision.Denied -> publish(
                    state.copy(
                        starting = false,
                        notice = VoiceNotice(
                            message = "Microphone permission needed.",
                            action = if (decision.canAskAgain) {
                                VoiceNoticeAction.RetryPermission
                            } else {
                                VoiceNoticeAction.OpenSettings
                            },
                        ),
                    ),
                )
            }
        }
    }

    private fun startRecognizer(token: Long) {
        val available = runCatching(recognizer::isAvailable).getOrDefault(false)
        if (!available) {
            publish(
                state.copy(
                    available = false,
                    starting = false,
                    notice = VoiceNotice("Voice recognition is unavailable."),
                ),
            )
            return
        }
        val listener = listenerFor(token)
        when (val result = runCatching { recognizer.start(token, listener) }
            .getOrElse { VoiceRecognitionStartResult.Failed(it.message ?: "Voice input failed to start.") }) {
            is VoiceRecognitionStartResult.Failed -> publish(
                state.copy(
                    starting = false,
                    notice = VoiceNotice(result.reason.ifBlank { "Voice input failed to start." }),
                ),
            )
            is VoiceRecognitionStartResult.Started -> {
                activeSession = result.session
                val transition = VoiceSessionReducer.reduce(
                    state.session,
                    VoiceSessionEvent.Started(token),
                )
                publish(state.copy(session = transition.state, starting = false, notice = null))
            }
        }
    }

    private fun listenerFor(token: Long): VoiceRecognitionListener = object : VoiceRecognitionListener {
        override fun onPartial(transcript: String) {
            dispatch(VoiceSessionEvent.Partial(token, transcript))
        }

        override fun onFinal(transcript: String) {
            dispatch(VoiceSessionEvent.Final(token, transcript))
        }

        override fun onEnd() {
            recognitionEnded(token)
        }

        override fun onError(error: VoiceRecognitionError) {
            recognitionFailed(token, error)
        }
    }

    private fun recognitionEnded(token: Long) {
        val session: VoiceRecognitionSession
        val continueListening: Boolean
        synchronized(this) {
            if (state.session.sessionToken != token) return
            session = activeSession ?: return
            activeSession = null
            continueListening = state.session.phase == VoiceCapturePhase.ListeningHeld ||
                state.session.phase == VoiceCapturePhase.ListeningLocked
        }
        if (continueListening) {
            runCatching(session::close)
            restartRecognizer(token)
            return
        }
        val audio = runCatching(session::finishSafeAudio).getOrNull()
        runCatching(session::close)
        val skip = VoiceRefinementPolicy.skipReason(
            safeCapture = audio != null,
            backendAvailable = refiner.available,
            durationMs = audio?.durationMs ?: 0,
            audioBytes = audio?.bytes?.size?.toLong() ?: 0,
        )
        synchronized(this) { pendingAudio = if (skip == null) audio else null }
        dispatch(VoiceSessionEvent.RecognitionEnded(token, canRefine = skip == null))
    }

    private fun restartRecognizer(token: Long) {
        synchronized(this) {
            if (closed || state.session.sessionToken != token || !state.session.listening) return
        }
        if (!runCatching(recognizer::isAvailable).getOrDefault(false)) {
            dispatch(VoiceSessionEvent.RecognitionEnded(token, canRefine = false))
            synchronized(this) {
                publish(
                    state.copy(
                        available = false,
                        notice = VoiceNotice("Voice recognition is unavailable."),
                    ),
                )
            }
            return
        }
        when (val result = runCatching { recognizer.start(token, listenerFor(token)) }
            .getOrElse { VoiceRecognitionStartResult.Failed(it.message ?: "Voice input failed.") }) {
            is VoiceRecognitionStartResult.Started -> synchronized(this) {
                if (closed || state.session.sessionToken != token || !state.session.listening) {
                    runCatching(result.session::cancel)
                    runCatching(result.session::close)
                } else {
                    activeSession = result.session
                }
            }
            is VoiceRecognitionStartResult.Failed -> {
                dispatch(VoiceSessionEvent.RecognitionEnded(token, canRefine = false))
                synchronized(this) {
                    publish(state.copy(notice = VoiceNotice(result.reason)))
                }
            }
        }
    }

    private fun recognitionFailed(token: Long, error: VoiceRecognitionError) {
        val session = synchronized(this) {
            if (state.session.sessionToken != token) return
            activeSession.also { activeSession = null }
        }
        runCatching { session?.close() }
        dispatch(VoiceSessionEvent.RecognitionEnded(token, canRefine = false))
        if (error == VoiceRecognitionError.Aborted || error == VoiceRecognitionError.NoSpeech) return
        val notice = when (error) {
            VoiceRecognitionError.PermissionDenied -> VoiceNotice(
                "Microphone permission needed.",
                VoiceNoticeAction.OpenSettings,
            )
            VoiceRecognitionError.ServiceUnavailable -> VoiceNotice("Voice recognition is unavailable.")
            else -> VoiceNotice("Voice input failed.")
        }
        synchronized(this) { publish(state.copy(notice = notice)) }
    }

    private fun dispatch(event: VoiceSessionEvent) {
        val effects = synchronized(this) {
            val transition = VoiceSessionReducer.reduce(state.session, event)
            if (transition.state != state.session) publish(state.copy(session = transition.state))
            transition.effects
        }
        effects.forEach(::perform)
    }

    private fun perform(effect: VoiceSessionEffect) {
        when (effect) {
            is VoiceSessionEffect.PublishDraft -> onDraft(effect.text)
            is VoiceSessionEffect.StopRecognizer -> synchronized(this) {
                activeSession?.let { runCatching(it::stop) }
            }
            is VoiceSessionEffect.CancelRecognizer -> {
                val session = synchronized(this) {
                    activeSession.also { activeSession = null }
                }
                runCatching { session?.cancel() }
                runCatching { session?.close() }
                synchronized(this) { pendingAudio = null }
            }
            is VoiceSessionEffect.Refine -> startRefinement(effect)
            is VoiceSessionEffect.CancelRefinement -> cancelRefinement()
        }
    }

    private fun startRefinement(effect: VoiceSessionEffect.Refine) {
        val audio = synchronized(this) {
            if (state.session.sessionToken != effect.sessionToken) return
            pendingAudio.also { pendingAudio = null }
        } ?: run {
            dispatch(VoiceSessionEvent.RefinementFailed(effect.sessionToken))
            return
        }
        val request = VoiceRefinementRequest(
            audio = audio.bytes,
            mimeType = audio.mimeType,
            projectPath = projectPath,
            durationMs = audio.durationMs,
        )
        val call = refiner.transcribe(request) { result ->
            finishRefinement(effect.sessionToken, result)
        }
        val timeout = scheduler.schedule(VoiceRefinementPolicy.TimeoutMs) {
            timeoutRefinement(effect.sessionToken)
        }
        synchronized(this) {
            if (state.session.sessionToken != effect.sessionToken || !state.session.refining) {
                call.cancel()
                timeout.cancel()
            } else {
                refinementCall = call
                refinementTimeout = timeout
            }
        }
    }

    private fun finishRefinement(token: Long, result: VoiceRefinementResult) {
        val timeout = synchronized(this) {
            if (state.session.sessionToken != token || !state.session.refining) return
            refinementCall = null
            refinementTimeout.also { refinementTimeout = null }
        }
        timeout?.cancel()
        when (result) {
            is VoiceRefinementResult.Accepted ->
                dispatch(VoiceSessionEvent.RefinementSucceeded(token, result.text))
            is VoiceRefinementResult.Malformed,
            is VoiceRefinementResult.Rejected,
            -> dispatch(VoiceSessionEvent.RefinementFailed(token))
        }
    }

    private fun timeoutRefinement(token: Long) {
        val call = synchronized(this) {
            if (state.session.sessionToken != token || !state.session.refining) return
            refinementTimeout = null
            refinementCall.also { refinementCall = null }
        }
        call?.cancel()
        dispatch(VoiceSessionEvent.RefinementFailed(token))
    }

    private fun cancelRefinement() {
        val pair = synchronized(this) {
            val current = refinementCall to refinementTimeout
            refinementCall = null
            refinementTimeout = null
            pendingAudio = null
            current
        }
        pair.first?.cancel()
        pair.second?.cancel()
    }

    private fun publish(next: VoiceComposerControllerState) {
        state = next
        onState(next)
    }
}
