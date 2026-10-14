package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.reviews.PrResult
import app.switchboard.mobile.domain.thread.ExpiredRequests
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneDemoRpcTest {
    private val now = PhoneDemoTestFixture.NOW
    private val fixture = PhoneDemoFixture.parse(PhoneDemoTestFixture.json(), now)
    private val scheduler = VirtualScheduler()
    private val scope = TransportScope("phone-demo", fixture.connectionId, 1)
    private val rpc = PhoneDemoRpc(fixture, scheduler, scope, nowMs = { now }, log = {})
    private val client = SwitchboardRemoteClient(fixture.connectionId, rpc)

    @After
    fun close() = rpc.close()

    private fun collect(): MutableList<RuntimeEventPayload> {
        val events = mutableListOf<RuntimeEventPayload>()
        rpc.onRuntimeEvent { _, event -> events += event }
        return events
    }

    /** Calls through the real client, so the app's own decoders read every answer. */
    private fun <T> await(call: ((RemoteResponse<T>) -> Unit) -> Unit): RemoteOutcome<T> {
        var outcome: RemoteOutcome<T>? = null
        call { outcome = it.outcome }
        scheduler.advanceBy(0)
        return requireNotNull(outcome) { "no answer" }
    }

    private fun <T> RemoteOutcome<T>.value(): T = when (this) {
        is RemoteOutcome.Success -> value
        is RemoteOutcome.Failure -> throw AssertionError("expected success, got $message")
    }

    @Test
    fun materializeReplacesEveryNowToken() {
        val raw = JsonCodec.encode(PhoneDemoFixture.materialize(JsonCodec.parse(PhoneDemoTestFixture.json()), now))
        assertFalse(raw.contains("@now"))
        val sample = PhoneDemoFixture.materialize(
            JsonCodec.parse("""{"a":"@now-500","b":["@now"],"c":"@nowhere","d":"@now+5"}"""),
            1000,
        ) as JsonObject
        assertEquals(JsonNumber("500"), sample.values["a"])
        assertEquals(JsonArray(listOf(JsonNumber("1000"))), sample.values["b"])
        assertEquals(JsonString("@nowhere"), sample.values["c"])
        assertEquals(JsonNumber("1005"), sample.values["d"])
    }

    @Test
    fun fixtureHasOneProjectAndAnApprovalRunningAndFinishedChat() {
        assertEquals("demo", fixture.connectionId)
        assertEquals("Demo machine", fixture.connectionLabel)
        assertEquals("acme-console", fixture.projectName)
        assertEquals(listOf("demo-approval", "demo-running", "demo-done"), fixture.chats.map { it.id })
        val pending = fixture.chats[0].pending.single()
        assertEquals("request.opened", (pending.values["type"] as JsonString).value)
        assertEquals("Bash", (pending.values["toolName"] as JsonString).value)
        val done = fixture.chats[2].messages
        assertTrue(done.any { (it.values["content"] as JsonString).value.contains("```mermaid") })
        assertEquals(3, done.count { it.values.containsKey("fileDiff") })
        assertEquals(now - 30_000, fixture.chats[0].updatedAt)
    }

    @Test
    fun globalScriptsFillThreadAndMessage() {
        val steps = fixture.script("demo-done", "reply", "m-1")
        assertEquals(List(4) { "demo-done" }, steps.map { (it.event.values["threadId"] as JsonString).value })
        val content = steps.single { (it.event.values["type"] as JsonString).value == "content" }
        assertEquals(JsonString("m-1"), content.event.values["messageId"])
    }

    @Test
    fun aChatScriptOverridesTheGlobalOne() {
        val first = fixture.script("demo-running", "interrupt", "m-1").first().event
        assertEquals(JsonString("tool.completed"), first.values["type"])
        assertEquals(JsonString("demo-running-t4"), first.values["toolId"])
    }

    @Test
    fun playsNothingUntilTheAppSubscribesThenTheConnectScripts() {
        scheduler.advanceBy(10_000)
        assertEquals(0, scheduler.pending())
        val events = collect()
        scheduler.advanceBy(0)
        assertTrue(events.any { it.type == "status" && it.threadId == "demo-running" && it.raw.values["status"] == JsonString("running") })
        assertTrue(events.any { it.type == "request.opened" && it.threadId == "demo-approval" })
        scheduler.advanceBy(10_000)
        assertEquals(JsonString("demo-running-t4"), events.last().raw.values["toolId"])
        assertEquals("tool.started", events.last().type)
        assertEquals("running", rpc.statusOf("demo-running"))
    }

    @Test
    fun answersTheListChannelsFromTheFixture() {
        val projects = await(client::getProjects).value()
        assertEquals(listOf("acme-console"), projects.map { it.name })
        assertEquals(3, projects.single().sessions.size)
        val rows = await { cb: (RemoteResponse<List<Conversation>>) -> Unit ->
            client.getConversations(fixture.projectPath, cb)
        }.value()
        assertEquals(listOf("demo-approval", "demo-running", "demo-done"), rows.map { it.id })
        val session = await { cb -> client.loadSession("demo-done", 200, cb) }.value()
        assertEquals("demo-done", session.meta?.id)
        assertEquals(fixture.chats[2].messages.size, session.messages.size)
        assertEquals(emptyList<Any>(), await(client::listWorkspaces).value())
        val list = (await(client::listPullRequests).value() as PrResult.Ok).data
        assertEquals(listOf(214L, 209L, 212L, 215L, 205L), list.prs.map { it.ref.number })
        val detail = (await { cb -> client.pullRequestDetail(list.prs[2].ref, cb) }.value() as PrResult.Ok).data
        assertEquals("Retry uploads when a signed URL expires", detail.summary.title)
        val linked = await { cb -> client.pullRequestLinkedChats(list.prs[2].ref, cb) }.value()
        assertEquals(listOf("demo-done"), linked.map { it.id })
        val started = await { cb ->
            client.startSession(StartSession("demo-done", ProviderKind.Claude, fixture.projectPath), cb)
        }.value()
        assertEquals("idle", started.status)
        assertTrue(await { cb -> client.markRead("demo-done", cb) }.value().ok)
        assertEquals(1, await { cb -> client.getPendingRequests("demo-approval", cb) }.value().size)
    }

    @Test
    fun refusesWhatTheDemoCannotDo() {
        val search = await { cb -> client.searchMessages("x", cb) }
        assertTrue((search as RemoteOutcome.Failure).message.contains(PhoneDemoRpc.NOT_IN_DEMO))
        val start = await { cb ->
            client.startSession(StartSession("new-chat", ProviderKind.Claude, "/x"), cb)
        }
        assertTrue((start as RemoteOutcome.Failure).message.contains(PhoneDemoRpc.NOT_IN_DEMO))
    }

    @Test
    fun approveRunsTheTestsClearsTheRequestAndASecondAnswerExpires() {
        val events = collect()
        scheduler.advanceBy(0)
        await { cb -> client.respondToRequest("demo-approval", "demo-approval-request", ApprovalDecision.Approve, callback = cb) }.value()
        scheduler.advanceBy(5_000)
        assertTrue(events.any { it.type == "tool.completed" && it.raw.values["toolId"] == JsonString("demo-approval-t3") })
        assertEquals("idle", rpc.statusOf("demo-approval"))
        assertEquals(0, await { cb -> client.getPendingRequests("demo-approval", cb) }.value().size)
        val again = await { cb ->
            client.respondToRequest("demo-approval", "demo-approval-request", ApprovalDecision.Deny, callback = cb)
        }
        assertTrue((again as RemoteOutcome.Failure).message.contains(ExpiredRequests.REFUSED))
    }

    @Test
    fun denySkipsTheTests() {
        val events = collect()
        await { cb -> client.respondToRequest("demo-approval", "demo-approval-request", ApprovalDecision.Deny, callback = cb) }.value()
        scheduler.advanceBy(5_000)
        assertFalse(events.any { it.type == "tool.started" && it.threadId == "demo-approval" })
        assertTrue(events.any { it.type == "content" && it.raw.values["messageId"] == JsonString("demo-approval-a5") })
    }

    @Test
    fun aSendEchoesTheMessageThenPlaysTheScriptedReply() {
        val events = collect()
        scheduler.advanceBy(10_000)
        events.clear()
        await { cb ->
            client.submitUserTurn("demo-done", "o-1", "hello", null, null, null, cb)
        }.value()
        val echo = events.first()
        assertEquals("user.message", echo.type)
        assertEquals(JsonString("o-1"), echo.raw.values["origin"])
        assertEquals(JsonString("hello"), echo.raw.values["text"])
        scheduler.advanceBy(5_000)
        assertEquals(JsonString("idle"), events.last().raw.values["status"])
        assertTrue(events.any { it.type == "content" && (it.raw.values["text"] as JsonString).value.contains("scripted") })
    }

    @Test
    fun stopEndsTheRunningTurnAndCancelsTheRestOfItsScript() {
        val events = collect()
        scheduler.advanceBy(1_000)
        val stopped = await { cb -> client.interrupt("demo-running", cb) }.value()
        assertEquals(JsonObject(linkedMapOf<String, JsonValue>("live" to JsonBoolean(true))), stopped.body)
        scheduler.advanceBy(10_000)
        assertFalse(events.any { it.type == "tool.started" && it.raw.values["toolId"] == JsonString("demo-running-t4") })
        assertEquals("idle", rpc.statusOf("demo-running"))
        val idle = await { cb -> client.interrupt("demo-done", cb) }.value()
        assertEquals(JsonObject(linkedMapOf<String, JsonValue>("live" to JsonBoolean(false))), idle.body)
    }

    @Test
    fun aLoadedThreadGetsTheEventsItsChatAlreadyPlayed() {
        val events = collect()
        scheduler.advanceBy(10_000)
        val played = events.count { it.threadId == "demo-running" }
        events.clear()
        await { cb -> client.loadSession("demo-running", 200, cb) }.value()
        assertEquals(played, events.count { it.threadId == "demo-running" })
        assertTrue(events.all { it.threadId == "demo-running" })
    }

    @Test
    fun emitsNothingAfterClose() {
        val events = collect()
        rpc.close()
        scheduler.advanceBy(30_000)
        assertEquals(emptyList<RuntimeEventPayload>(), events)
        assertNull(rpc.scope)
        val after = await(client::getProjects)
        assertTrue(after is RemoteOutcome.Failure)
    }
}
