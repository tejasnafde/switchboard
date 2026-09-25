package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonBoolean
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

    @Test
    fun theCurrentTurnsDigestIsThePreviewAndANewTurnClearsIt() {
        val index = BrowseThreadActivityIndex()
        fun preview() = index.state(scope).value.getValue("thread").preview
        fun chunk(messageId: String, text: String, append: Boolean) = event(
            "content",
            "streamKind" to JsonString("assistant"),
            "messageId" to JsonString(messageId),
            "text" to JsonString(text),
            "append" to JsonBoolean(append),
        )

        index.onEvent(scope, chunk("m1", "Reading the ", append = false))
        index.onEvent(scope, chunk("m1", "**config** file", append = true))
        assertEquals("Reading the config file", preview())

        index.onEvent(scope, chunk("m1", " <agent_digest>Checking config</agent_digest>", append = true))
        // A later message of the same turn without a digest keeps the earlier digest.
        index.onEvent(scope, chunk("m2", "Now running tests", append = false))
        assertEquals("Checking config", preview())

        index.onEvent(scope, event("content", "streamKind" to JsonString("reasoning"), "messageId" to JsonString("r"), "text" to JsonString("thinking")))
        assertEquals("Checking config", preview())

        index.onEvent(scope, event("user.message", "text" to JsonString("next")))
        assertEquals(null, preview())
    }

    @Test
    fun aPlanNeedsYouUntilTheNextUserMessageAndAStopClearsEverything() {
        val index = BrowseThreadActivityIndex()
        fun attention() = index.state(scope).value.getValue("thread").attention

        index.onEvent(scope, event("plan.proposed", "planId" to JsonString("p1")))
        assertEquals(BrowseThreadAttention.Plan, attention())
        index.onEvent(scope, event("user.message", "text" to JsonString("go")))
        assertEquals(BrowseThreadAttention.None, attention())

        index.onEvent(scope, event("request.opened", "requestId" to JsonString("r1")))
        index.onEvent(scope, event("status", "status" to JsonString("stopped")))
        assertEquals(BrowseThreadAttention.None, attention())
    }

    @Test
    fun theBackendSeedMarksAChatAndCannotReopenACardClosedLive() {
        val index = BrowseThreadActivityIndex()
        fun attention() = index.state(scope).value.getValue("thread").attention
        fun pending(type: String, field: String, id: String) = JsonObject(
            linkedMapOf("type" to JsonString(type), "threadId" to JsonString("thread"), field to JsonString(id)),
        )

        index.seedPending(scope, "thread", listOf(pending("question.asked", "requestId", "q1")))
        assertEquals(BrowseThreadAttention.Input, attention())

        index.onEvent(scope, event("request.opened", "requestId" to JsonString("r1")))
        index.onEvent(scope, event("request.closed", "requestId" to JsonString("r1")))
        // A reply that raced the close still lists r1.
        index.seedPending(scope, "thread", listOf(pending("request.opened", "requestId", "r1"), pending("plan.proposed", "planId", "p1")))
        assertEquals(BrowseThreadAttention.Plan, attention())

        index.seedPending(scope, "thread", emptyList())
        assertEquals(BrowseThreadAttention.None, attention())
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
