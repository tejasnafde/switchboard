package app.switchboard.mobile.domain.voice

data class VoiceDraft(
    val text: String,
    val revision: Long,
)

enum class VoiceCapturePhase {
    Idle,
    ListeningHeld,
    ListeningLocked,
    Stopping,
    Refining,
}

data class VoiceSessionState(
    val draft: VoiceDraft,
    val phase: VoiceCapturePhase = VoiceCapturePhase.Idle,
    val sessionToken: Long? = null,
    val originalDraft: VoiceDraft? = null,
    val committedBase: String = draft.text,
    val nativeFinal: String? = null,
    val stopRevision: Long? = null,
) {
    val listening: Boolean
        get() = phase == VoiceCapturePhase.ListeningHeld ||
            phase == VoiceCapturePhase.ListeningLocked ||
            phase == VoiceCapturePhase.Stopping

    val locked: Boolean
        get() = phase == VoiceCapturePhase.ListeningLocked

    val refining: Boolean
        get() = phase == VoiceCapturePhase.Refining
}

sealed interface VoiceSessionEvent {
    data class Started(val sessionToken: Long) : VoiceSessionEvent
    data class Partial(val sessionToken: Long, val transcript: String) : VoiceSessionEvent
    data class Final(val sessionToken: Long, val transcript: String) : VoiceSessionEvent
    data class Lock(val sessionToken: Long) : VoiceSessionEvent
    data class Stop(val sessionToken: Long) : VoiceSessionEvent
    data class Cancel(val sessionToken: Long) : VoiceSessionEvent
    data class RecognitionEnded(
        val sessionToken: Long,
        val canRefine: Boolean,
    ) : VoiceSessionEvent
    data class RefinementSucceeded(
        val sessionToken: Long,
        val transcript: String,
    ) : VoiceSessionEvent
    data class RefinementFailed(val sessionToken: Long) : VoiceSessionEvent
    data class UserEdited(val text: String) : VoiceSessionEvent
    data object Dispose : VoiceSessionEvent
}

sealed interface VoiceSessionEffect {
    data class PublishDraft(val text: String) : VoiceSessionEffect
    data class StopRecognizer(val sessionToken: Long) : VoiceSessionEffect
    data class CancelRecognizer(val sessionToken: Long) : VoiceSessionEffect
    data class Refine(
        val sessionToken: Long,
        val originalDraft: String,
        val nativeFinal: String,
        val stopRevision: Long,
    ) : VoiceSessionEffect
    data class CancelRefinement(val sessionToken: Long) : VoiceSessionEffect
}

data class VoiceSessionTransition(
    val state: VoiceSessionState,
    val effects: List<VoiceSessionEffect> = emptyList(),
)

object VoiceSessionReducer {
    fun reduce(
        state: VoiceSessionState,
        event: VoiceSessionEvent,
    ): VoiceSessionTransition = when (event) {
        is VoiceSessionEvent.Started -> start(state, event)
        is VoiceSessionEvent.Partial -> transcript(state, event.sessionToken, event.transcript, final = false)
        is VoiceSessionEvent.Final -> transcript(state, event.sessionToken, event.transcript, final = true)
        is VoiceSessionEvent.Lock -> lock(state, event.sessionToken)
        is VoiceSessionEvent.Stop -> stop(state, event.sessionToken)
        is VoiceSessionEvent.Cancel -> cancel(state, event.sessionToken)
        is VoiceSessionEvent.RecognitionEnded -> recognitionEnded(state, event)
        is VoiceSessionEvent.RefinementSucceeded -> refinementSucceeded(state, event)
        is VoiceSessionEvent.RefinementFailed -> refinementFailed(state, event.sessionToken)
        is VoiceSessionEvent.UserEdited -> userEdited(state, event.text)
        VoiceSessionEvent.Dispose -> dispose(state)
    }

    private fun start(
        state: VoiceSessionState,
        event: VoiceSessionEvent.Started,
    ): VoiceSessionTransition {
        if (state.phase != VoiceCapturePhase.Idle) return VoiceSessionTransition(state)
        return VoiceSessionTransition(
            state.copy(
                phase = VoiceCapturePhase.ListeningHeld,
                sessionToken = event.sessionToken,
                originalDraft = state.draft,
                committedBase = state.draft.text,
                nativeFinal = null,
                stopRevision = null,
            ),
        )
    }

    private fun transcript(
        state: VoiceSessionState,
        token: Long,
        transcript: String,
        final: Boolean,
    ): VoiceSessionTransition {
        if (state.sessionToken != token || !state.listening) return VoiceSessionTransition(state)
        val nextText = joinDraft(state.committedBase, transcript)
        val nextDraft = state.draft.withText(nextText)
        val nextBase = if (final) nextText else state.committedBase
        val nextState = state.copy(
            draft = nextDraft,
            committedBase = nextBase,
            nativeFinal = if (state.phase == VoiceCapturePhase.Stopping) nextText else state.nativeFinal,
            stopRevision = if (state.phase == VoiceCapturePhase.Stopping) nextDraft.revision else state.stopRevision,
        )
        val effects = if (nextDraft == state.draft) {
            emptyList()
        } else {
            listOf(VoiceSessionEffect.PublishDraft(nextText))
        }
        return VoiceSessionTransition(nextState, effects)
    }

    private fun lock(state: VoiceSessionState, token: Long): VoiceSessionTransition {
        if (state.sessionToken != token || state.phase != VoiceCapturePhase.ListeningHeld) {
            return VoiceSessionTransition(state)
        }
        return VoiceSessionTransition(state.copy(phase = VoiceCapturePhase.ListeningLocked))
    }

    private fun stop(state: VoiceSessionState, token: Long): VoiceSessionTransition {
        if (
            state.sessionToken != token ||
            state.phase !in setOf(VoiceCapturePhase.ListeningHeld, VoiceCapturePhase.ListeningLocked)
        ) {
            return VoiceSessionTransition(state)
        }
        return VoiceSessionTransition(
            state.copy(
                phase = VoiceCapturePhase.Stopping,
                nativeFinal = state.draft.text,
                stopRevision = state.draft.revision,
            ),
            listOf(VoiceSessionEffect.StopRecognizer(token)),
        )
    }

    private fun cancel(state: VoiceSessionState, token: Long): VoiceSessionTransition {
        if (state.sessionToken != token || !state.listening) return VoiceSessionTransition(state)
        val original = state.originalDraft ?: return VoiceSessionTransition(state)
        val restored = VoiceDraft(original.text, state.draft.revision + 1)
        return VoiceSessionTransition(
            idle(state.copy(draft = restored, committedBase = restored.text)),
            listOf(
                VoiceSessionEffect.CancelRecognizer(token),
                VoiceSessionEffect.PublishDraft(restored.text),
            ),
        )
    }

    private fun recognitionEnded(
        state: VoiceSessionState,
        event: VoiceSessionEvent.RecognitionEnded,
    ): VoiceSessionTransition {
        if (state.sessionToken != event.sessionToken) return VoiceSessionTransition(state)
        if (state.phase != VoiceCapturePhase.Stopping) return VoiceSessionTransition(idle(state))
        val nativeFinal = state.nativeFinal ?: state.draft.text
        val stopRevision = state.stopRevision ?: state.draft.revision
        if (!event.canRefine) return VoiceSessionTransition(idle(state))
        return VoiceSessionTransition(
            state.copy(
                phase = VoiceCapturePhase.Refining,
                nativeFinal = nativeFinal,
                stopRevision = stopRevision,
            ),
            listOf(
                VoiceSessionEffect.Refine(
                    sessionToken = event.sessionToken,
                    originalDraft = state.originalDraft?.text.orEmpty(),
                    nativeFinal = nativeFinal,
                    stopRevision = stopRevision,
                ),
            ),
        )
    }

    private fun refinementSucceeded(
        state: VoiceSessionState,
        event: VoiceSessionEvent.RefinementSucceeded,
    ): VoiceSessionTransition {
        if (state.sessionToken != event.sessionToken || state.phase != VoiceCapturePhase.Refining) {
            return VoiceSessionTransition(state)
        }
        val corrected = joinDraft(state.originalDraft?.text.orEmpty(), event.transcript)
        val applies = event.transcript.isNotBlank() &&
            state.stopRevision == state.draft.revision &&
            state.nativeFinal == state.draft.text &&
            corrected != state.draft.text
        if (!applies) return VoiceSessionTransition(idle(state))
        val nextDraft = state.draft.withText(corrected)
        return VoiceSessionTransition(
            idle(state.copy(draft = nextDraft, committedBase = corrected)),
            listOf(VoiceSessionEffect.PublishDraft(corrected)),
        )
    }

    private fun refinementFailed(state: VoiceSessionState, token: Long): VoiceSessionTransition {
        if (state.sessionToken != token || state.phase != VoiceCapturePhase.Refining) {
            return VoiceSessionTransition(state)
        }
        return VoiceSessionTransition(idle(state))
    }

    private fun userEdited(state: VoiceSessionState, text: String): VoiceSessionTransition {
        val nextDraft = state.draft.withText(text)
        if (nextDraft == state.draft) return VoiceSessionTransition(state)
        val base = if (state.phase in setOf(
                VoiceCapturePhase.ListeningHeld,
                VoiceCapturePhase.ListeningLocked,
            )
        ) {
            text
        } else {
            state.committedBase
        }
        return VoiceSessionTransition(state.copy(draft = nextDraft, committedBase = base))
    }

    private fun dispose(state: VoiceSessionState): VoiceSessionTransition {
        val token = state.sessionToken ?: return VoiceSessionTransition(idle(state))
        val effects = when (state.phase) {
            VoiceCapturePhase.ListeningHeld,
            VoiceCapturePhase.ListeningLocked,
            VoiceCapturePhase.Stopping,
            -> listOf(VoiceSessionEffect.CancelRecognizer(token))

            VoiceCapturePhase.Refining -> listOf(VoiceSessionEffect.CancelRefinement(token))
            VoiceCapturePhase.Idle -> emptyList()
        }
        return VoiceSessionTransition(idle(state), effects)
    }

    private fun idle(state: VoiceSessionState): VoiceSessionState = state.copy(
        phase = VoiceCapturePhase.Idle,
        sessionToken = null,
        originalDraft = null,
        committedBase = state.draft.text,
        nativeFinal = null,
        stopRevision = null,
    )

    private fun joinDraft(base: String, transcript: String): String = when {
        transcript.isEmpty() -> base
        base.isEmpty() || base.last().isWhitespace() -> base + transcript
        else -> "$base $transcript"
    }

    private fun VoiceDraft.withText(text: String): VoiceDraft =
        if (this.text == text) this else VoiceDraft(text, revision + 1)
}
