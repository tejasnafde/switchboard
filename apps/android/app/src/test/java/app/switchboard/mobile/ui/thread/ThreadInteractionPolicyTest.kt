package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.QuestionOption
import app.switchboard.mobile.domain.thread.ThreadQuestion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadInteractionPolicyTest {
    @Test
    fun approvalPlanAndFileActionsPreserveDurableIdentifiers() {
        val approval = FeedItem.Approval("a", "request-1", "Bash", "run", "tool", "pending")
        val plan = FeedItem.Plan("p", "plan-1", "Ship")
        val file = FeedItem.FileEdit("f", "edit-1", "/repo", "src/App.kt", "modify", "a", "b")

        assertEquals(
            ThreadUiAction.Approval("request-1", ThreadApprovalDecision.APPROVE),
            ThreadInteractionPolicy.approval(approval, ThreadApprovalDecision.APPROVE),
        )
        assertEquals(
            ThreadUiAction.Plan("plan-1", ThreadPlanAction.ITERATE),
            ThreadInteractionPolicy.plan(plan, ThreadPlanAction.ITERATE),
        )
        assertEquals(
            ThreadUiAction.OpenFile("edit-1", "/repo", "src/App.kt"),
            ThreadInteractionPolicy.openFile(file),
        )
    }

    @Test
    fun resolvedApprovalCannotEmitAnotherDecision() {
        val resolved = FeedItem.Approval("a", "request-1", "Bash", "run", "tool", "approve")

        assertNull(ThreadInteractionPolicy.approval(resolved, ThreadApprovalDecision.DENY))
    }

    @Test
    fun questionSelectionsAreIsolatedByRequestIdAndRespectMultiSelect() {
        val first = question("request-1", multiSelect = false)
        val second = question("request-2", multiSelect = true)
        var selections = QuestionSelections.empty()

        selections = QuestionSelectionReducer.toggle(selections, first, 0, "A")
        selections = QuestionSelectionReducer.toggle(selections, first, 0, "B")
        selections = QuestionSelectionReducer.toggle(selections, second, 0, "A")
        selections = QuestionSelectionReducer.toggle(selections, second, 0, "B")

        assertEquals(listOf(listOf("B")), selections.forRequest("request-1"))
        assertEquals(listOf(listOf("A", "B")), selections.forRequest("request-2"))
        assertTrue(QuestionSelectionReducer.canSubmit(selections, first))
        assertTrue(QuestionSelectionReducer.canSubmit(selections, second))
        assertEquals(
            ThreadUiAction.AnswerQuestion("request-2", listOf(listOf("A", "B"))),
            ThreadInteractionPolicy.answer(second, selections),
        )
    }

    @Test
    fun incompleteOrAlreadyAnsweredQuestionCannotSubmit() {
        val pending = question("pending", multiSelect = false)
        val answered = pending.copy(answers = listOf(listOf("A")))

        assertFalse(QuestionSelectionReducer.canSubmit(QuestionSelections.empty(), pending))
        assertNull(ThreadInteractionPolicy.answer(pending, QuestionSelections.empty()))
        assertNull(ThreadInteractionPolicy.answer(answered, QuestionSelections.empty()))
    }

    private fun question(requestId: String, multiSelect: Boolean) = FeedItem.Question(
        id = "q-$requestId",
        requestId = requestId,
        questions = listOf(
            ThreadQuestion(
                id = "choice",
                header = "Choose",
                question = "Which?",
                options = listOf(QuestionOption("A", null), QuestionOption("B", null)),
                multiSelect = multiSelect,
            ),
        ),
    )
}
