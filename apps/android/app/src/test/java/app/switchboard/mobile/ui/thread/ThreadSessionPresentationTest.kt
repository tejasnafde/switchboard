package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadComposerState
import app.switchboard.mobile.data.thread.ThreadSessionControl
import app.switchboard.mobile.data.thread.ThreadSessionLoad
import app.switchboard.mobile.data.thread.ThreadSessionPlanAction
import app.switchboard.mobile.data.thread.ThreadSessionState
import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.thread.FeedItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadSessionPresentationTest {
    @Test
    fun `session load maps cached ready and failure state without dropping feed`() {
        val thread = ThreadState(feed = listOf(FeedItem.User("u", "saved", 1)))

        assertEquals(thread, (ThreadSessionLoad.Loading(thread).toUiLoadState() as ThreadLoadState.Loading).cached)
        assertEquals(thread, (ThreadSessionLoad.Ready(thread).toUiLoadState() as ThreadLoadState.Ready).thread)
        assertEquals(thread, (ThreadSessionLoad.Failed("offline", thread).toUiLoadState() as ThreadLoadState.Failed).cached)
    }

    @Test
    fun `every UI action maps to the exact session control`() {
        assertEquals(
            ThreadSessionControl.Approval("request", ApprovalDecision.Approve),
            ThreadUiAction.Approval("request", ThreadApprovalDecision.APPROVE).toSessionControl(),
        )
        assertEquals(
            ThreadSessionControl.AnswerQuestion("question", listOf(listOf("A"))),
            ThreadUiAction.AnswerQuestion("question", listOf(listOf("A"))).toSessionControl(),
        )
        assertEquals(
            ThreadSessionControl.Plan("plan", ThreadSessionPlanAction.Implement),
            ThreadUiAction.Plan("plan", ThreadPlanAction.IMPLEMENT).toSessionControl(),
        )
        assertEquals(
            ThreadSessionControl.Plan("plan", ThreadSessionPlanAction.Iterate),
            ThreadUiAction.Plan("plan", ThreadPlanAction.ITERATE).toSessionControl(),
        )
        assertEquals(
            ThreadSessionControl.OpenFile("edit", "/repo", "src/A.kt"),
            ThreadUiAction.OpenFile("edit", "/repo", "src/A.kt").toSessionControl(),
        )
    }

    @Test
    fun `composer presentation exposes separate send and interrupt decisions`() {
        val running = ThreadSessionState(
            load = ThreadSessionLoad.Ready(ThreadState(status = "running")),
            composer = ThreadComposerState(draft = "follow up", runtimeMode = RuntimeMode.Plan),
        ).toComposerPresentation()

        assertTrue(running.canSend)
        assertTrue(running.showInterrupt)
        assertEquals(RuntimeMode.Plan, running.runtimeMode)

        val submitting = running.copy(submitting = true)
        assertFalse(submitting.canSendNow())
        assertTrue(submitting.showInterrupt)
    }
}
