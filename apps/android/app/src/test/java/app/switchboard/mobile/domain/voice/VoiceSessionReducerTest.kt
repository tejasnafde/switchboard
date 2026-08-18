package app.switchboard.mobile.domain.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceSessionReducerTest {
    @Test
    fun `partials compose over the original draft and finals accumulate`() {
        var state = VoiceSessionState(draft = VoiceDraft("review this", revision = 7))
        state = reduce(state, VoiceSessionEvent.Started(sessionToken = 11)).state

        state = reduce(state, VoiceSessionEvent.Partial(11, "use dictation")).state
        assertEquals("review this use dictation", state.draft.text)

        state = reduce(state, VoiceSessionEvent.Final(11, "use dictation")).state
        state = reduce(state, VoiceSessionEvent.Partial(11, "dot tee ess")).state
        assertEquals("review this use dictation dot tee ess", state.draft.text)

        state = reduce(state, VoiceSessionEvent.Final(11, "dot tee ess")).state
        assertEquals("review this use dictation dot tee ess", state.draft.text)
        assertEquals("review this use dictation dot tee ess", state.committedBase)
    }

    @Test
    fun `sideways cancel restores the exact pre-capture draft and invalidates late callbacks`() {
        val original = "  preserve spacing exactly  "
        var state = VoiceSessionState(VoiceDraft(original, revision = 3))
        state = reduce(state, VoiceSessionEvent.Started(21)).state
        state = reduce(state, VoiceSessionEvent.Partial(21, "temporary words")).state

        val cancelled = reduce(state, VoiceSessionEvent.Cancel(21))
        assertEquals(original, cancelled.state.draft.text)
        assertEquals(VoiceCapturePhase.Idle, cancelled.state.phase)
        assertNull(cancelled.state.sessionToken)
        assertTrue(cancelled.effects.contains(VoiceSessionEffect.CancelRecognizer(21)))
        assertTrue(cancelled.effects.contains(VoiceSessionEffect.PublishDraft(original)))

        val late = reduce(cancelled.state, VoiceSessionEvent.Final(21, "stale final"))
        assertEquals(cancelled.state, late.state)
        assertTrue(late.effects.isEmpty())
    }

    @Test
    fun `normal release keeps native text and starts refinement only after recognition ends`() {
        var state = VoiceSessionState(VoiceDraft("base", revision = 1))
        state = reduce(state, VoiceSessionEvent.Started(31)).state
        state = reduce(state, VoiceSessionEvent.Final(31, "native words")).state

        val stopping = reduce(state, VoiceSessionEvent.Stop(31))
        assertEquals(VoiceCapturePhase.Stopping, stopping.state.phase)
        assertEquals("base native words", stopping.state.draft.text)
        assertEquals(listOf(VoiceSessionEffect.StopRecognizer(31)), stopping.effects)

        val ended = reduce(stopping.state, VoiceSessionEvent.RecognitionEnded(31, canRefine = true))
        assertEquals(VoiceCapturePhase.Refining, ended.state.phase)
        assertEquals(
            listOf(VoiceSessionEffect.Refine(31, "base", "base native words", ended.state.draft.revision)),
            ended.effects,
        )
    }

    @Test
    fun `a user edit after stop always wins over a stale refinement`() {
        var state = refiningState(token = 41)
        state = reduce(state, VoiceSessionEvent.UserEdited("base native plus my edit")).state
        val revisionAfterEdit = state.draft.revision

        val result = reduce(state, VoiceSessionEvent.RefinementSucceeded(41, "corrected words"))

        assertEquals("base native plus my edit", result.state.draft.text)
        assertEquals(revisionAfterEdit, result.state.draft.revision)
        assertEquals(VoiceCapturePhase.Idle, result.state.phase)
        assertTrue(result.effects.isEmpty())
    }

    @Test
    fun `revision fencing rejects stale refinement even when text returns to native final`() {
        var state = refiningState(token = 51)
        val native = state.draft.text
        state = reduce(state, VoiceSessionEvent.UserEdited("changed")).state
        state = reduce(state, VoiceSessionEvent.UserEdited(native)).state

        val result = reduce(state, VoiceSessionEvent.RefinementSucceeded(51, "corrected words"))

        assertEquals(native, result.state.draft.text)
        assertEquals(VoiceCapturePhase.Idle, result.state.phase)
        assertTrue(result.effects.isEmpty())
    }

    @Test
    fun `current nonblank refinement replaces only the dictated portion`() {
        val state = refiningState(token = 61)

        val result = reduce(state, VoiceSessionEvent.RefinementSucceeded(61, "corrected words"))

        assertEquals("base corrected words", result.state.draft.text)
        assertEquals(VoiceCapturePhase.Idle, result.state.phase)
        assertEquals(listOf(VoiceSessionEffect.PublishDraft("base corrected words")), result.effects)
    }

    @Test
    fun `backgrounding releases capture without rolling back useful native text`() {
        var state = VoiceSessionState(VoiceDraft("before", 2))
        state = reduce(state, VoiceSessionEvent.Started(71)).state
        state = reduce(state, VoiceSessionEvent.Partial(71, "spoken")).state

        val disposed = reduce(state, VoiceSessionEvent.Dispose)

        assertEquals("before spoken", disposed.state.draft.text)
        assertEquals(VoiceCapturePhase.Idle, disposed.state.phase)
        assertFalse(disposed.state.refining)
        assertEquals(listOf(VoiceSessionEffect.CancelRecognizer(71)), disposed.effects)
        assertTrue(reduce(disposed.state, VoiceSessionEvent.Dispose).effects.isEmpty())
    }

    private fun refiningState(token: Long): VoiceSessionState {
        var state = VoiceSessionState(VoiceDraft("base", revision = 4))
        state = reduce(state, VoiceSessionEvent.Started(token)).state
        state = reduce(state, VoiceSessionEvent.Final(token, "native")).state
        state = reduce(state, VoiceSessionEvent.Stop(token)).state
        return reduce(state, VoiceSessionEvent.RecognitionEnded(token, canRefine = true)).state
    }

    private fun reduce(
        state: VoiceSessionState,
        event: VoiceSessionEvent,
    ): VoiceSessionTransition = VoiceSessionReducer.reduce(state, event)
}
