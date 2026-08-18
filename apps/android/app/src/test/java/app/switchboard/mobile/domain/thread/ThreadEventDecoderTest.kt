package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadEventDecoderTest {
    @Test
    fun decodesEveryKnownRuntimeEventWithoutDroppingExtensionFields() {
        val fixtures = listOf(
            event("content", "messageId" to s("m1"), "text" to s("hello"), "append" to b(true), "streamKind" to s("assistant")) to ThreadEventKind.Content,
            event("user.message", "text" to s("hi"), "origin" to s("phone-1"), "at" to n(10)) to ThreadEventKind.UserMessage,
            event("tool.started", "toolId" to s("tool-1"), "toolName" to s("Read"), "input" to obj("path" to s("a.kt"))) to ThreadEventKind.ToolStarted,
            event("tool.completed", "toolId" to s("tool-1"), "output" to s("done")) to ThreadEventKind.ToolCompleted,
            event("tool.denied", "toolName" to s("Write"), "reason" to s("plan mode"), "mode" to s("plan")) to ThreadEventKind.ToolDenied,
            event("request.opened", "requestId" to s("r1"), "requestType" to s("tool"), "toolName" to s("Bash"), "detail" to s("npm test")) to ThreadEventKind.RequestOpened,
            event("request.closed", "requestId" to s("r1"), "decision" to s("approve")) to ThreadEventKind.RequestClosed,
            event("turn.completed", "turnId" to s("turn-1"), "costUsd" to n("0.12"), "usedTokens" to n(9), "maxTokens" to n(100), "numTurns" to n(2), "durationMs" to n(1200)) to ThreadEventKind.TurnCompleted,
            event("turn.retrying", "turnId" to s("turn-1"), "message" to s("retrying")) to ThreadEventKind.TurnRetrying,
            event("error", "message" to s("failed"), "turnId" to s("turn-1")) to ThreadEventKind.Error,
            event("status", "status" to s("running")) to ThreadEventKind.Status,
            event("session", "sessionId" to s("session-1")) to ThreadEventKind.Session,
            event("session.provider", "provider" to s("codex"), "instanceId" to JsonNull, "instanceName" to JsonNull) to ThreadEventKind.SessionProvider,
            event("context_window", "usedTokens" to n(44), "maxTokens" to JsonNull, "model" to s("gpt-5.6-luna"), "costUsd" to n("0.5")) to ThreadEventKind.ContextWindow,
            event("model.variants", "modelId" to s("m"), "availableVariants" to arr(s("low"), s("high")), "currentVariant" to s("high")) to ThreadEventKind.ModelVariants,
            event("plan.proposed", "planId" to s("p1"), "planMarkdown" to s("# Plan")) to ThreadEventKind.PlanProposed,
            event("question.asked", "requestId" to s("q1"), "questions" to arr(question())) to ThreadEventKind.QuestionAsked,
            event("question.answered", "requestId" to s("q1"), "answers" to arr(arr(s("A"), s("B")))) to ThreadEventKind.QuestionAnswered,
            event("file.edited", "turnId" to s("turn-1"), "fileEditId" to s("edit-1"), "repoRoot" to s("/repo"), "relPath" to s("a.kt"), "changeKind" to s("modify"), "oldContent" to s("old"), "newContent" to s("new")) to ThreadEventKind.FileEdited,
            event("worktree.drift", "worktreePath" to s("/repo/.switchboard/w"), "branch" to s("sb/w")) to ThreadEventKind.WorktreeDrift,
            event("spend.blocked", "instanceId" to JsonNull, "model" to s("fable"), "reason" to s("disabled"), "scope" to s("not-provisioned"), "resetsAtMs" to n(50)) to ThreadEventKind.SpendBlocked,
            event("thread.read", "at" to n(80)) to ThreadEventKind.ThreadRead,
            event("peer.message", "direction" to s("received"), "initiator" to s("agent"), "messageId" to s("peer-1"), "peerThreadId" to s("other"), "peerLabel" to s("Other"), "text" to s("hello"), "at" to n(90)) to ThreadEventKind.PeerMessage,
            event("todo.updated", "todoId" to s("todo-1"), "items" to arr(obj("text" to s("Ship"), "status" to s("in_progress")))) to ThreadEventKind.TodoUpdated,
        )

        fixtures.forEach { (raw, kind) ->
            val decoded = ThreadEventDecoder.decode(raw)
            assertEquals(kind, decoded.kind)
            assertEquals(s("kept"), decoded.raw.values["future"])
        }
    }

    @Test
    fun malformedKnownAndUnknownEventsBecomeNonFatalVisibleExtensions() {
        val malformed = ThreadEventDecoder.decode(event("content", "text" to s("missing ids")))
        val extension = ThreadEventDecoder.decode(event("provider.future", "payload" to n(3)))

        assertTrue(malformed is ThreadRuntimeEvent.Malformed)
        assertTrue(extension is ThreadRuntimeEvent.Extension)
        assertEquals("provider.future", extension.type)
        assertEquals(n(3), extension.raw.values["payload"])
    }

    private fun question() = obj(
        "id" to s("choice"),
        "header" to s("Choose"),
        "question" to s("Which?"),
        "options" to arr(obj("label" to s("A"), "description" to s("First"))),
        "multiSelect" to b(false),
    )

    private fun event(type: String, vararg fields: Pair<String, JsonValue>): JsonObject =
        obj(
            "type" to s(type),
            "threadId" to s("thread-1"),
            *fields,
            "future" to s("kept"),
        )

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))
    private fun arr(vararg values: JsonValue) = JsonArray(values.toList())
    private fun s(value: String) = JsonString(value)
    private fun b(value: Boolean) = JsonBoolean(value)
    private fun n(value: Long) = JsonNumber(value.toString())
    private fun n(value: String) = JsonNumber(value)
}
