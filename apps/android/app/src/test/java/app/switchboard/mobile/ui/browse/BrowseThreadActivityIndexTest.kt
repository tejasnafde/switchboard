package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventKind
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowseThreadActivityIndexTest {
    private val scope = TransportScope("phone", "machine", 7)

    @Test
    fun assistantChunksCountOncePerTurnAndThreadReadClearsUnread() {
        val index = BrowseThreadActivityIndex()

        index.onEvent(scope, event("content", "streamKind" to JsonString("assistant")))
        index.onEvent(scope, event("content", "streamKind" to JsonString("assistant")))
        assertEquals(1, index.state(scope).value.getValue("thread").unread)

        index.onEvent(scope, event("turn.completed"))
        index.onEvent(scope, event("content", "streamKind" to JsonString("assistant")))
        assertEquals(2, index.state(scope).value.getValue("thread").unread)

        index.onEvent(scope, event("thread.read"))
        assertEquals(0, index.state(scope).value.getValue("thread").unread)
    }

    @Test
    fun activityIsStrictlyGenerationScoped() {
        val index = BrowseThreadActivityIndex()
        val stale = scope.copy(generation = 6)
        index.onEvent(stale, event("error"))
        index.onEvent(scope, event("status", "status" to JsonString("running")))

        assertEquals("error", index.state(stale).value.getValue("thread").status)
        assertEquals("running", index.state(scope).value.getValue("thread").status)

        index.discardOtherGenerations("machine", 7)
        assertEquals(emptyMap<String, BrowseThreadActivity>(), index.state(stale).value)
    }

    @Test
    fun approvalAndQuestionEventsProjectActionableAttentionWithoutThreadState() {
        val index = BrowseThreadActivityIndex()

        index.onEvent(scope, event("question.asked", "requestId" to JsonString("question-1")))
        assertEquals(
            BrowseThreadAttention.Input,
            index.state(scope).value.getValue("thread").attention,
        )

        index.onEvent(scope, event("request.opened", "requestId" to JsonString("approval-1")))
        assertEquals(
            BrowseThreadAttention.Approval,
            index.state(scope).value.getValue("thread").attention,
        )

        index.onEvent(scope, event("request.closed", "requestId" to JsonString("approval-1")))
        assertEquals(
            BrowseThreadAttention.Input,
            index.state(scope).value.getValue("thread").attention,
        )

        index.onEvent(scope, event("question.answered", "requestId" to JsonString("question-1")))
        assertEquals(
            BrowseThreadAttention.None,
            index.state(scope).value.getValue("thread").attention,
        )
    }

    @Test
    fun closingOneRequestDoesNotClearAnotherPendingRequest() {
        val index = BrowseThreadActivityIndex()

        index.onEvent(scope, event("request.opened", "requestId" to JsonString("approval-1")))
        index.onEvent(scope, event("request.opened", "requestId" to JsonString("approval-2")))
        index.onEvent(scope, event("request.closed", "requestId" to JsonString("approval-1")))

        assertEquals(
            BrowseThreadAttention.Approval,
            index.state(scope).value.getValue("thread").attention,
        )

        index.onEvent(scope, event("request.closed", "requestId" to JsonString("approval-2")))
        assertEquals(
            BrowseThreadAttention.None,
            index.state(scope).value.getValue("thread").attention,
        )
    }

    private fun event(
        type: String,
        vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>,
    ) = RuntimeEventPayload(
        type = type,
        threadId = "thread",
        kind = RuntimeEventKind.Known,
        raw = JsonObject(
            linkedMapOf(
                "type" to JsonString(type),
                "threadId" to JsonString("thread"),
                *fields,
            ),
        ),
    )
}
