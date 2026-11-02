package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ChatSettle
import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.platform.log.SbLog
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ChatSettleStoreTest {
    @Before
    fun quietLog() {
        SbLog.sink = SbLog.Sink { _, _, _, _ -> }
    }

    @Test
    fun `a settle takes the row out before the answer and calls the desktop channel`() {
        val rpc = FakeRpc()
        val store = ChatSettleStore()
        val done = mutableListOf<String?>()
        store.settle(SwitchboardRemoteClient("mac", rpc), "a", 500, done::add)
        assertEquals(500L, store.of("mac", "a"))
        assertEquals(listOf("app:settle-conversation" to listOf<JsonValue>(JsonString("a"))), rpc.calls)

        rpc.answer(ok(true))
        assertEquals(listOf<String?>(null), done)
        assertEquals(500L, store.of("mac", "a"))
    }

    @Test
    fun `a refused settle brings the row back and says so`() {
        val rpc = FakeRpc()
        val store = ChatSettleStore()
        val done = mutableListOf<String?>()
        store.settle(SwitchboardRemoteClient("mac", rpc), "a", 500, done::add)
        rpc.answer(ok(false))
        assertEquals(listOf<String?>("Could not settle. Try again"), done)
        assertFalse("a" in store.state.value["mac"].orEmpty())
    }

    @Test
    fun `Undo unsettles at once, and a failed one leaves the chat settled`() {
        val rpc = FakeRpc()
        val store = ChatSettleStore()
        val done = mutableListOf<String?>()
        val undo = ChatSettle.Undo("mac", "a", 500, "Settled a")
        store.undo(SwitchboardRemoteClient("mac", rpc), undo, ChatSnoozeStore(), 600, done::add)
        assertTrue("a" in store.state.value.getValue("mac"))
        assertNull(store.of("mac", "a"))
        assertEquals("app:unsettle-conversation", rpc.calls.single().first)

        rpc.fail()
        assertEquals(listOf<String?>("Could not undo the settle. Try again"), done)
        assertEquals(500L, store.of("mac", "a"))
    }

    @Test
    fun `Undo of a settle that ended a snooze snoozes again with its revision, which also unsettles`() {
        val rpc = FakeRpc()
        val store = ChatSettleStore()
        val snoozes = ChatSnoozeStore()
        val done = mutableListOf<String?>()
        val ended = ChatSettle.EndedSnooze(until = 9_000, pr = "github:acme/app#7", rev = 4)
        store.undo(SwitchboardRemoteClient("mac", rpc), ChatSettle.Undo("mac", "a", 500, "Settled a", ended), snoozes, 600, done::add)

        val (channel, args) = rpc.calls.single()
        assertEquals("app:snooze-conversation", channel)
        assertEquals(ChatSettle.restoreRequest(ended), args[1])
        rpc.answer(obj("ok" to JsonBoolean(true), "until" to JsonNumber("9000"), "pr" to JsonNull, "rev" to JsonNumber("5")))
        assertEquals(listOf<String?>(null), done)
        assertEquals(1, rpc.calls.size)
        assertEquals(ChatSnooze.State(snoozedUntil = 9_000, snoozedAt = 600, snoozeRev = 5, unsettled = true), snoozes.of("mac", "a"))
        assertNull(store.of("mac", "a"))
    }

    @Test
    fun `a refused snooze restore still unsettles`() {
        val rpc = FakeRpc()
        val store = ChatSettleStore()
        val done = mutableListOf<String?>()
        val ended = ChatSettle.EndedSnooze(until = null, pr = "github:acme/app#7", rev = 4)
        store.undo(SwitchboardRemoteClient("mac", rpc), ChatSettle.Undo("mac", "a", 500, "Settled a", ended), ChatSnoozeStore(), 600, done::add)
        rpc.answer(obj("ok" to JsonBoolean(false), "reason" to JsonString("pr_closed")))
        assertEquals("app:unsettle-conversation", rpc.calls.last().first)
        rpc.answer(ok(true))
        assertEquals(listOf<String?>(null), done)
    }

    @Test
    fun `an entry goes once the project list agrees with it`() {
        val store = ChatSettleStore()
        store.put("mac", "settled", 500)
        store.put("mac", "unsettled", null)
        store.applyEvent("mac", ChatSettle.Event("broadcast", 700))

        store.reconcile("mac", listOf(session("settled", null), session("unsettled", null), session("broadcast", 700)))
        assertEquals(mapOf<String, Long?>("settled" to 500L), store.state.value["mac"])

        store.reconcile("mac", listOf(session("settled", 501)))
        assertEquals(emptyMap<String, Long?>(), store.state.value["mac"])
    }

    private fun ok(value: Boolean) = obj("ok" to JsonBoolean(value))

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))

    private fun session(id: String, settledAt: Long?) = SessionSummary(
        id = id,
        source = "codex",
        title = id,
        startedAt = 1,
        messageCount = 1,
        filePath = "/tmp/$id.jsonl",
        raw = JsonObject(linkedMapOf()),
        settledAt = settledAt,
    )

    /** Holds each call until the test answers it. */
    private class FakeRpc : RemoteRpc {
        override val scope: TransportScope = TransportScope("pixel", "mac", 7)
        val calls = mutableListOf<Pair<String, List<JsonValue>>>()
        private val pending = ArrayDeque<(RpcOutcome) -> Unit>()

        override fun invoke(
            expectedScope: TransportScope,
            channel: String,
            args: JsonArray,
            callback: (RpcOutcome) -> Unit,
        ): RequestSubmission {
            calls += channel to args.values
            pending += callback
            return RequestSubmission.Accepted(calls.size.toLong(), scope)
        }

        override fun onRuntimeEvent(listener: (TransportScope, RuntimeEventPayload) -> Unit): Cancelable = Cancelable {}

        fun answer(value: JsonValue?) = pending.removeFirst()(RpcOutcome.Success(value))

        fun fail() = pending.removeFirst()(RpcOutcome.Failure(RpcFailure.Timeout))
    }
}
