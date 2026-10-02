package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.HostWriteCards
import app.switchboard.mobile.domain.thread.HostWriteResponse
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.domain.thread.QuestionOption
import app.switchboard.mobile.domain.thread.ThreadQuestion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadInteractionPolicyTest {
    @Test
    fun approvalAndPlanActionsPreserveDurableIdentifiers() {
        val approval = FeedItem.Approval("a", "request-1", "Bash", "run", "tool", "pending")
        val plan = FeedItem.Plan("p", "plan-1", "Ship")

        assertEquals(
            ThreadUiAction.Approval("request-1", ThreadApprovalDecision.APPROVE),
            ThreadInteractionPolicy.approval(approval, ThreadApprovalDecision.APPROVE),
        )
        assertEquals(
            ThreadUiAction.Plan("plan-1", ThreadPlanAction.ITERATE),
            ThreadInteractionPolicy.plan(plan, ThreadPlanAction.ITERATE),
        )
    }

    @Test
    fun hostWriteCardIsApprovableOnlyOnABackendThatTakesAPhoneApproval() {
        val card = HostWriteCards.decode(
            JsonObject(linkedMapOf("action" to JsonString("resolve"), "host" to JsonString("github"), "prLabel" to JsonString("app #1"), "target" to TARGET)),
        )!!
        val approval = FeedItem.Approval("a", "sbmcp_1", "mcp__switchboard__resolve_conversation", "Resolve", "tool", "pending", card)

        val actions = ThreadInteractionPolicy.approvalActions(approval, backendTakesPhoneApproval = true) as ApprovalActions.HostWrite
        assertEquals(listOf("Resolve"), actions.buttons.map { it.label })
        assertEquals(HostWriteResponse(shown = HostWriteCards.shownDigest("sbmcp_1", card)), actions.buttons.single().response)
        assertEquals(ApprovalActions.DenyOnly(card), ThreadInteractionPolicy.approvalActions(approval, backendTakesPhoneApproval = false))
        assertEquals(ApprovalActions.Plain, ThreadInteractionPolicy.approvalActions(approval.copy(hostWrite = null), backendTakesPhoneApproval = false))
        assertEquals(
            ThreadUiAction.Approval("sbmcp_1", ThreadApprovalDecision.APPROVE, HostWriteResponse(verdict = "comment")),
            ThreadInteractionPolicy.approval(approval, ThreadApprovalDecision.APPROVE, HostWriteResponse(verdict = "comment")),
        )
    }

    @Test
    fun quietAnswerIsOfferedOnlyOnServerCardsOfABackendThatTakesIt() {
        val server = FeedItem.Approval("a", "sbmcp_1", "send_agent_message", "msg", "tool", "pending")
        val adapter = FeedItem.Approval("b", "request-1", "Bash", "run", "tool", "pending")
        assertTrue(ThreadInteractionPolicy.offersQuiet(server, backendAsyncApproval = true))
        assertFalse(ThreadInteractionPolicy.offersQuiet(server, backendAsyncApproval = false))
        assertFalse(ThreadInteractionPolicy.offersQuiet(adapter, backendAsyncApproval = true))
        assertEquals(HostWriteResponse(quiet = true), ThreadInteractionPolicy.quietly(null, quiet = true))
        assertEquals(HostWriteResponse(verdict = "comment", quiet = true), ThreadInteractionPolicy.quietly(HostWriteResponse(verdict = "comment"), quiet = true))
        assertNull(ThreadInteractionPolicy.quietly(null, quiet = false))
    }

    @Test
    fun longReplyIsShownInFullAndApprovableOnlyOnceOpened() {
        val long = (1..40).joinToString("\n") { "Line $it of the reply." }
        val approval = hostWriteApproval("action" to JsonString("reply"), "replyText" to JsonString(long))
        val actions = ThreadInteractionPolicy.approvalActions(approval, backendTakesPhoneApproval = true) as ApprovalActions.HostWrite
        assertEquals(long, actions.preview.sections.single().text)
        assertFalse(ThreadInteractionPolicy.hostWriteApprovable(actions, expanded = false))
        assertTrue(ThreadInteractionPolicy.hostWriteApprovable(actions, expanded = true))
    }

    @Test
    fun longReviewShowsEveryCommentInFullBeforeAVerdictIsEnabled() {
        val comments = (1..4).map { i ->
            JsonObject(linkedMapOf("path" to JsonString("src/f$i.ts"), "side" to JsonString("new"), "line" to JsonNumber("${10 + i}"), "text" to JsonString("x".repeat(500) + " end $i")))
        }
        val approval = hostWriteApproval(
            "action" to JsonString("review"),
            "review" to JsonObject(linkedMapOf("summary" to JsonString("Notes."), "comments" to JsonArray(comments), "verdicts" to JsonArray(listOf(JsonString("approve"))))),
        )
        val actions = ThreadInteractionPolicy.approvalActions(approval, backendTakesPhoneApproval = true) as ApprovalActions.HostWrite
        assertEquals(
            listOf("Summary" to "Notes.") + (1..4).map { "src/f$it.ts:${10 + it}" to "x".repeat(500) + " end $it" },
            actions.preview.sections.map { it.label to it.text },
        )
        assertFalse(ThreadInteractionPolicy.hostWriteApprovable(actions, expanded = false))
        assertTrue(ThreadInteractionPolicy.hostWriteApprovable(actions, expanded = true))
    }

    @Test
    fun cardThePhoneCannotShowInFullIsDenyOnly() {
        val approval = hostWriteApproval("action" to JsonString("review"), "review" to JsonObject(linkedMapOf("summary" to JsonString("Notes."))))
        assertEquals(ApprovalActions.DenyOnly(approval.hostWrite!!), ThreadInteractionPolicy.approvalActions(approval, backendTakesPhoneApproval = true))
    }

    private fun hostWriteApproval(vararg fields: Pair<String, JsonValue>): FeedItem.Approval {
        val card = HostWriteCards.decode(JsonObject(linkedMapOf("host" to JsonString("github"), "prLabel" to JsonString("app #1"), "target" to TARGET, *fields)))!!
        return FeedItem.Approval("a", "sbmcp_1", "mcp__switchboard__x", "capped detail", "tool", "pending", card)
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

    private companion object {
        val TARGET = JsonObject(linkedMapOf("repository" to JsonString("acme/app"), "number" to JsonNumber("1")))
    }
}
