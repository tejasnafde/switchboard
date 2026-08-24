package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.ConnectionPhase
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import app.switchboard.mobile.protocol.WsProtocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WsCoordinatorTest {
    @Test
    fun typedChannelListenersReceiveReplayableNonProviderEventsAndCanUnsubscribe() {
        val fixture = Fixture()
        val call = fixture.connectReady()
        val received = mutableListOf<Pair<TransportScope, JsonArray>>()
        val subscription = fixture.coordinator.onChannelEvent("worktree-creation:progress") { scope, args ->
            received += scope to args
        }
        val args = JsonArray(
            listOf(
                JsonObject(linkedMapOf("creationId" to JsonString("creation-1"))),
            ),
        )

        call.listener.onText(
            WsProtocol.encode(WsFrame.Event("worktree-creation:progress", args, sequence = 1)),
        )

        assertEquals(args, received.single().second)
        assertEquals("studio-mac", received.single().first.connectionId)

        subscription.cancel()
        call.listener.onText(
            WsProtocol.encode(WsFrame.Event("worktree-creation:progress", args, sequence = 2)),
        )
        assertEquals(1, received.size)
    }

    @Test
    fun socketOpenAuthenticatesButApplicationRequestsWaitForReady() {
        val fixture = Fixture()
        fixture.coordinator.connect(fixture.target())
        val call = fixture.dialer.calls.single()
        val outcomes = mutableListOf<RpcOutcome>()

        assertEquals(
            RequestSubmission.Rejected(RpcFailure.NotReady),
            fixture.coordinator.invoke("provider:send-turn", JsonArray(emptyList()), outcomes::add),
        )
        assertTrue(call.socket.sent.isEmpty())

        call.listener.onOpen(call.socket)
        assertEquals(
            listOf(WsFrame.Auth(session = "session-device-7")),
            call.socket.sent.map { WsProtocol.decode(it) },
        )
        assertFalse(fixture.coordinator.isApplicationSendAllowed)

        call.listener.onText(
            WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
        )
        assertEquals(WsFrame.Hello(null), WsProtocol.decode(call.socket.sent.last()))
        assertFalse(fixture.coordinator.isApplicationSendAllowed)

        call.listener.onText(
            WsProtocol.encode(WsFrame.Ready("epoch-a", 0, replayed = 0, gap = false)),
        )
        assertTrue(fixture.coordinator.isApplicationSendAllowed)

        val submission = fixture.coordinator.invoke(
            "provider:send-turn",
            JsonArray(listOf(JsonString("thread-1"))),
            outcomes::add,
        )
        assertTrue(submission is RequestSubmission.Accepted)
        assertTrue(WsProtocol.decode(call.socket.sent.last()) is WsFrame.Request)
        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.NotReady)), outcomes)
    }

    @Test
    fun `socket open without ready times out terminally instead of redialing forever`() {
        val fixture = Fixture()
        fixture.coordinator.connect(fixture.target())
        val call = fixture.dialer.calls.single()

        call.listener.onOpen(call.socket)

        assertEquals(listOf(15_000L), fixture.scheduler.activeTasks().map { it.delayMs })
        fixture.scheduler.runTaskWithDelay(15_000L)

        assertTrue(call.socket.closed)
        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
        assertEquals(
            listOf("BackendHandshakeTimedOut"),
            fixture.observer.transportFailures.mapNotNull {
                (it as? NonRetryableTransportFailure)?.reason?.name
            },
        )
    }

    @Test
    fun `handshake watchdog is cancelled by ready replacement disconnect and destroy`() {
        val ready = Fixture()
        val readyCall = ready.connectReady()
        assertTrue(ready.scheduler.activeTasks().isEmpty())
        ready.scheduler.runTaskEvenIfCancelled(15_000L)
        assertFalse(readyCall.socket.closed)
        assertTrue(ready.observer.transportFailures.isEmpty())

        val replaced = Fixture()
        replaced.coordinator.connect(replaced.target())
        val oldCall = replaced.dialer.calls.single()
        oldCall.listener.onOpen(oldCall.socket)
        replaced.coordinator.connect(replaced.target(connectionId = "replacement"))
        replaced.scheduler.runTaskEvenIfCancelled(15_000L)
        assertTrue(replaced.observer.transportFailures.isEmpty())

        val disconnected = Fixture()
        disconnected.coordinator.connect(disconnected.target())
        disconnected.dialer.calls.single().listener.onOpen(disconnected.dialer.calls.single().socket)
        disconnected.coordinator.disconnect()
        disconnected.scheduler.runTaskEvenIfCancelled(15_000L)
        assertTrue(disconnected.observer.transportFailures.isEmpty())

        val destroyed = Fixture()
        destroyed.coordinator.connect(destroyed.target())
        destroyed.dialer.calls.single().listener.onOpen(destroyed.dialer.calls.single().socket)
        destroyed.coordinator.destroy()
        destroyed.scheduler.runTaskEvenIfCancelled(15_000L)
        assertTrue(destroyed.observer.transportFailures.isEmpty())
    }

    @Test
    fun legacySharedTokenSendsHelloWithoutFrameAuthAndAcceptsOnlyCurrentReady() {
        val fixture = Fixture()
        fixture.coordinator.connect(
            fixture.target(credential = Credential.LegacySharedToken("legacy-secret")),
        )
        val old = fixture.dialer.calls.single()
        assertFalse(old.target.url.contains("legacy-secret"))
        old.listener.onOpen(old.socket)

        assertEquals(
            listOf(WsFrame.Hello(null)),
            old.socket.sent.mapNotNull(WsProtocol::decode),
        )
        assertFalse(fixture.coordinator.isApplicationSendAllowed)

        fixture.coordinator.connect(
            fixture.target(deviceId = "tablet", connectionId = "replacement"),
        )
        old.listener.onText(
            WsProtocol.encode(WsFrame.Ready("stale", 9, replayed = 0, gap = false)),
        )
        assertFalse(fixture.coordinator.isApplicationSendAllowed)

        val current = fixture.dialer.calls.last()
        current.listener.onOpen(current.socket)
        current.listener.onText(
            WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
        )
        current.listener.onText(
            WsProtocol.encode(WsFrame.Ready("current", 1, replayed = 0, gap = false)),
        )
        assertTrue(fixture.coordinator.isApplicationSendAllowed)
    }

    @Test
    fun pendingRegistryIsBoundedTimesOutAndPreservesDomainFailuresInSuccess() {
        val fixture = Fixture(maxPending = 2)
        val call = fixture.connectReady()
        val first = mutableListOf<RpcOutcome>()
        val second = mutableListOf<RpcOutcome>()
        val rejected = mutableListOf<RpcOutcome>()

        val one = fixture.coordinator.invoke("one", JsonArray(emptyList()), first::add)
            as RequestSubmission.Accepted
        val two = fixture.coordinator.invoke("two", JsonArray(emptyList()), second::add)
            as RequestSubmission.Accepted
        assertEquals(
            RequestSubmission.Rejected(RpcFailure.CapacityExceeded),
            fixture.coordinator.invoke("three", JsonArray(emptyList()), rejected::add),
        )
        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.CapacityExceeded)), rejected)

        fixture.scheduler.runTaskWithDelay(10_000)
        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.Timeout)), first)
        assertEquals(1, fixture.coordinator.pendingRequestCount)

        val domainResult = JsonObject(
            linkedMapOf(
                "ok" to JsonBoolean(false),
                "code" to JsonString("display_unsupported"),
            ),
        )
        call.listener.onText(
            WsProtocol.encode(WsFrame.Response.Success(two.requestId, domainResult)),
        )
        assertEquals(listOf(RpcOutcome.Success(domainResult)), second)
        assertEquals(0, fixture.coordinator.pendingRequestCount)

        call.listener.onText(
            WsProtocol.encode(WsFrame.Response.Failure(one.requestId, "late response")),
        )
        assertEquals(1, first.size)
    }

    @Test
    fun scopedInvocationCannotRaceOntoAReplacementConnection() {
        val fixture = Fixture()
        val call = fixture.connectReady()
        val staleScope = fixture.coordinator.currentScope!!
        fixture.coordinator.connect(
            fixture.target(deviceId = "tablet", connectionId = "work-vm"),
        )
        val outcomes = mutableListOf<RpcOutcome>()
        val sentBefore = call.socket.sent.size

        val submission = fixture.coordinator.invoke(
            staleScope,
            "app:get-projects",
            JsonArray(emptyList()),
            outcomes::add,
        )

        assertEquals(RequestSubmission.Rejected(RpcFailure.ConnectionReplaced), submission)
        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.ConnectionReplaced)), outcomes)
        assertEquals(sentBefore, call.socket.sent.size)
    }

    @Test
    fun deviceSwitchDrainsPendingAndInvalidatesEveryOldSocketCallback() {
        val fixture = Fixture()
        val oldCall = fixture.connectReady()
        val outcomes = mutableListOf<RpcOutcome>()
        val request = fixture.coordinator.invoke(
            "provider:send-turn",
            JsonArray(emptyList()),
            outcomes::add,
        ) as RequestSubmission.Accepted

        fixture.coordinator.connect(
            fixture.target(deviceId = "tablet", connectionId = "work-vm"),
        )
        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.ConnectionReplaced)), outcomes)
        assertEquals(0, fixture.coordinator.pendingRequestCount)

        oldCall.listener.onText(
            WsProtocol.encode(WsFrame.Response.Success(request.requestId, JsonString("stale"))),
        )
        oldCall.listener.onText(
            WsProtocol.encode(
                WsFrame.Event(
                    "provider:event",
                    JsonArray(listOf(runtimeEvent("stale"))),
                    99,
                ),
            ),
        )
        oldCall.listener.onFailure(IllegalStateException("old socket"))

        assertEquals(1, outcomes.size)
        assertTrue(fixture.observer.runtimeEvents.isEmpty())
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
    }

    @Test
    fun pairingSessionIsSavedBeforeLegacyCredentialsRetireAndBeforeHello() {
        val fixture = Fixture()
        fixture.coordinator.connect(
            fixture.target(credential = Credential.Pairing("PAIR-4821", "Pixel 9")),
        )
        val call = fixture.dialer.calls.single()
        call.socket.log = fixture.operationLog
        call.listener.onOpen(call.socket)
        call.listener.onText(
            WsProtocol.encode(
                WsFrame.Authed.Success("minted-device-session", listOf("provider")),
            ),
        )

        assertEquals(
            listOf(
                "send:auth",
                "save-and-verify:studio-mac:native-ref:minted-device-session",
                "retire-legacy:studio-mac",
                "send:hello",
            ),
            fixture.operationLog,
        )
    }

    @Test
    fun failedPairingSessionVerificationKeepsLegacyCredentialsAndStopsHandshake() {
        val fixture = Fixture()
        fixture.credentialStore.sessionVerified = false
        fixture.coordinator.connect(
            fixture.target(credential = Credential.Pairing("PAIR-4821", "Pixel 9")),
        )
        val call = fixture.dialer.calls.single()
        call.socket.log = fixture.operationLog
        call.listener.onOpen(call.socket)
        call.listener.onText(
            WsProtocol.encode(
                WsFrame.Authed.Success("unverified-session", listOf("provider")),
            ),
        )

        assertEquals(
            listOf(
                "send:auth",
                "save-and-verify:studio-mac:native-ref:unverified-session",
            ),
            fixture.operationLog,
        )
        assertEquals(
            listOf(WsFrame.Auth(pairing = "PAIR-4821", label = "Pixel 9")),
            call.socket.sent.mapNotNull(WsProtocol::decode),
        )
        assertTrue(call.socket.closed)
        assertFalse(fixture.coordinator.isApplicationSendAllowed)
        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)
    }

    @Test
    fun rejectedPairingClosesTheSocketAndDoesNotRetry() {
        val fixture = Fixture()
        fixture.coordinator.connect(
            fixture.target(credential = Credential.Pairing("expired-code", "Pixel 9")),
        )
        val call = fixture.dialer.calls.single()
        call.listener.onOpen(call.socket)

        call.listener.onText(
            WsProtocol.encode(WsFrame.Authed.Failure("pairing code expired")),
        )

        assertTrue(call.socket.closed)
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
        assertFalse(fixture.coordinator.isApplicationSendAllowed)
        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)
    }

    @Test
    fun `authentication rejected close is terminal and never redials`() {
        val fixture = Fixture()
        fixture.coordinator.connect(fixture.target())
        val call = fixture.dialer.calls.single()
        call.listener.onOpen(call.socket)

        call.listener.onClosed(DisconnectCause.AuthenticationRejected)

        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
        assertEquals(1, fixture.dialer.calls.size)
    }

    @Test
    fun cursorPersistsOnlyAfterAcceptedReadyAndEventSequencing() {
        val fixture = Fixture()
        fixture.cursorStore.cursors["studio-mac"] = ResumeCursor("epoch-a", 40)
        fixture.coordinator.connect(fixture.target())
        val call = fixture.dialer.calls.single()
        call.listener.onOpen(call.socket)
        call.listener.onText(
            WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
        )
        assertEquals(
            WsFrame.Hello(ResumeCursor("epoch-a", 40)),
            WsProtocol.decode(call.socket.sent.last()),
        )

        call.listener.onText(
            WsProtocol.encode(
                WsFrame.Event(
                    "provider:event",
                    JsonArray(listOf(runtimeEvent("replayed"))),
                    41,
                ),
            ),
        )
        assertTrue(fixture.cursorStore.saves.isEmpty())

        call.listener.onText(
            WsProtocol.encode(WsFrame.Ready("epoch-a", 42, replayed = 1, gap = false)),
        )
        assertEquals(listOf("replayed"), fixture.observer.runtimeEvents.map { it.type })
        assertEquals(
            listOf("studio-mac" to ResumeCursor("epoch-a", 42)),
            fixture.cursorStore.saves,
        )

        call.listener.onText(
            WsProtocol.encode(
                WsFrame.Event(
                    "provider:event",
                    JsonArray(listOf(runtimeEvent("live"))),
                    43,
                ),
            ),
        )
        assertEquals(
            "studio-mac" to ResumeCursor("epoch-a", 43),
            fixture.cursorStore.saves.last(),
        )
    }

    @Test
    fun replayGapMalformedFramesAndRuntimeFramesReachInjectedPorts() {
        val fixture = Fixture()
        fixture.cursorStore.cursors["studio-mac"] = ResumeCursor("old-epoch", 200)
        fixture.coordinator.connect(fixture.target())
        val call = fixture.dialer.calls.single()
        call.listener.onOpen(call.socket)
        call.listener.onText(
            WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
        )
        call.listener.onText("not-json")
        call.listener.onText(
            WsProtocol.encode(WsFrame.Ready("new-epoch", 3, replayed = 0, gap = true)),
        )

        assertEquals(listOf("not-json"), fixture.observer.protocolErrors)
        assertEquals(
            listOf(ResumeCursor("old-epoch", 200) to ResumeCursor("new-epoch", 3)),
            fixture.observer.replayGaps,
        )
    }

    @Test
    fun backoffIsCancelableAndReconnectCallbacksUseANewGeneration() {
        val fixture = Fixture()
        fixture.coordinator.connect(fixture.target())
        val first = fixture.dialer.calls.single()
        first.listener.onFailure(IllegalStateException("network"))

        assertEquals(listOf(1_000L), fixture.scheduler.activeTasks().map { it.delayMs })
        fixture.scheduler.runNext()
        assertEquals(2, fixture.dialer.calls.size)
        val second = fixture.dialer.calls.last()
        second.listener.onFailure(IllegalStateException("network again"))
        assertEquals(listOf(2_000L), fixture.scheduler.activeTasks().map { it.delayMs })

        fixture.coordinator.connect(
            fixture.target(deviceId = "tablet", connectionId = "work-vm"),
        )
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
    }

    @Test
    fun closeAndServiceDestructionDrainPendingWithTypedFailures() {
        val fixture = Fixture()
        fixture.connectReady()
        val closed = mutableListOf<RpcOutcome>()
        fixture.coordinator.invoke("one", JsonArray(emptyList()), closed::add)
        fixture.coordinator.disconnect()
        assertEquals(
            listOf(RpcOutcome.Failure(RpcFailure.ConnectionLost(DisconnectCause.UserRequested))),
            closed,
        )
        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)

        fixture.coordinator.connect(fixture.target())
        val call = fixture.dialer.calls.last()
        call.listener.onOpen(call.socket)
        call.listener.onText(
            WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
        )
        call.listener.onText(
            WsProtocol.encode(WsFrame.Ready("epoch-a", 1, replayed = 0, gap = false)),
        )
        val destroyed = mutableListOf<RpcOutcome>()
        fixture.coordinator.invoke("two", JsonArray(emptyList()), destroyed::add)
        fixture.coordinator.destroy()

        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.ServiceDestroyed)), destroyed)
        assertFalse(fixture.coordinator.isApplicationSendAllowed)
        assertEquals(0, fixture.coordinator.pendingRequestCount)
    }

    @Test
    fun `offline launch parks dial and network regain dials immediately`() {
        val fixture = Fixture()
        fixture.coordinator.setNetworkAvailable(false)

        fixture.coordinator.connect(fixture.target())
        assertTrue(fixture.dialer.calls.isEmpty())

        fixture.coordinator.setNetworkAvailable(true)
        assertEquals(1, fixture.dialer.calls.size)
    }

    @Test
    fun `losing network parks retry without inflating backoff and regain redials once`() {
        val fixture = Fixture()
        fixture.coordinator.connect(fixture.target())
        val first = fixture.dialer.calls.single()
        first.listener.onFailure(IllegalStateException("offline"))
        assertEquals(listOf(1_000L), fixture.scheduler.activeTasks().map { it.delayMs })

        fixture.coordinator.setNetworkAvailable(false)
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
        fixture.scheduler.runTaskEvenIfCancelled(delayMs = 1_000)
        assertEquals(1, fixture.dialer.calls.size)
        fixture.coordinator.setNetworkAvailable(true)

        assertEquals(2, fixture.dialer.calls.size)
        assertTrue(fixture.scheduler.activeTasks().isEmpty())
        first.listener.onOpen(first.socket)
        assertFalse(first.socket.sent.isNotEmpty())
    }

    @Test
    fun `network loss invalidates a silently stale ready socket before regain redials`() {
        val fixture = Fixture()
        val first = fixture.connectReady()
        val firstScope = requireNotNull(fixture.coordinator.currentScope)
        val outcomes = mutableListOf<RpcOutcome>()
        fixture.coordinator.invoke("provider:send-turn", JsonArray(emptyList()), outcomes::add)

        fixture.coordinator.setNetworkAvailable(false)

        assertTrue(first.socket.closed)
        assertEquals(
            listOf(RpcOutcome.Failure(RpcFailure.ConnectionLost(DisconnectCause.Network))),
            outcomes,
        )
        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)
        assertTrue(fixture.scheduler.activeTasks().isEmpty())

        fixture.coordinator.setNetworkAvailable(true)

        assertEquals(2, fixture.dialer.calls.size)
        assertTrue(fixture.coordinator.currentScope != firstScope)
        first.listener.onText(WsProtocol.encode(WsFrame.Pong(1)))
        assertEquals(ConnectionPhase.Disconnected, fixture.coordinator.phase)
    }

    @Test
    fun `disconnect destroy and auth rejection cannot redial on later network regain`() {
        val disconnected = Fixture()
        disconnected.coordinator.setNetworkAvailable(false)
        disconnected.coordinator.connect(disconnected.target())
        disconnected.coordinator.disconnect()
        disconnected.coordinator.setNetworkAvailable(true)
        assertTrue(disconnected.dialer.calls.isEmpty())

        val destroyed = Fixture()
        destroyed.coordinator.setNetworkAvailable(false)
        destroyed.coordinator.connect(destroyed.target())
        destroyed.coordinator.destroy()
        destroyed.coordinator.setNetworkAvailable(true)
        assertTrue(destroyed.dialer.calls.isEmpty())

        val rejected = Fixture()
        val call = rejected.connectReady()
        call.listener.onText(WsProtocol.encode(WsFrame.Authed.Failure("rejected")))
        rejected.coordinator.setNetworkAvailable(false)
        rejected.coordinator.setNetworkAvailable(true)
        assertEquals(1, rejected.dialer.calls.size)
    }

    @Test
    fun `foreground probe is generation fenced and reconnects only after unanswered timeout`() {
        val fixture = Fixture()
        val first = fixture.connectReady()

        fixture.coordinator.probe(timeoutMs = 3_000)
        assertTrue(WsProtocol.decode(first.socket.sent.last()) is WsFrame.Ping)
        first.listener.onText(WsProtocol.encode(WsFrame.Pong(1)))
        assertTrue(fixture.scheduler.activeTasks().none { it.delayMs == 3_000L })

        fixture.coordinator.probe(timeoutMs = 3_000)
        fixture.scheduler.runTaskWithDelay(3_000)
        assertTrue(first.socket.closed)
        assertEquals(listOf(1_000L), fixture.scheduler.activeTasks().map { it.delayMs })

        first.listener.onText(WsProtocol.encode(WsFrame.Pong(2)))
        assertEquals(listOf(1_000L), fixture.scheduler.activeTasks().map { it.delayMs })
    }

    private fun runtimeEvent(type: String): JsonObject = JsonObject(
        linkedMapOf(
            "type" to JsonString(type),
            "threadId" to JsonString("thread-1"),
        ),
    )

    private class Fixture(maxPending: Int = 32) {
        val operationLog = mutableListOf<String>()
        val dialer = FakeDialer()
        val scheduler = FakeScheduler()
        val cursorStore = FakeCursorStore()
        val credentialStore = FakeCredentialStore(operationLog)
        val observer = FakeObserver()
        val coordinator = AuthenticatedWsCoordinator(
            dialer = dialer,
            scheduler = scheduler,
            cursorStore = cursorStore,
            credentialStore = credentialStore,
            observer = observer,
            maxPendingRequests = maxPending,
            requestTimeoutMs = 10_000,
        )

        fun target(
            deviceId: String = "pixel-9",
            connectionId: String = "studio-mac",
            credential: Credential = Credential.Session("session-device-7"),
            credentialRef: String? = "native-ref",
        ) = WebSocketTarget(
            deviceId = deviceId,
            connectionId = connectionId,
            url = "wss://switchboard.test/ws",
            credential = credential,
            credentialRef = credentialRef,
        )

        fun connectReady(): FakeDialer.Call {
            coordinator.connect(target())
            val call = dialer.calls.last()
            call.listener.onOpen(call.socket)
            call.listener.onText(
                WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
            )
            call.listener.onText(
                WsProtocol.encode(WsFrame.Ready("epoch-a", 0, replayed = 0, gap = false)),
            )
            return call
        }
    }

    private class FakeDialer : WebSocketDialer {
        data class Call(
            val target: WebSocketTarget,
            val listener: WebSocketCallbacks,
            val socket: FakeSocket = FakeSocket(),
        )

        val calls = mutableListOf<Call>()

        override fun open(target: WebSocketTarget, callbacks: WebSocketCallbacks): WebSocketConnection {
            return Call(target, callbacks).also(calls::add).socket
        }
    }

    private class FakeSocket : WebSocketConnection {
        val sent = mutableListOf<String>()
        var closed = false
        var log: MutableList<String>? = null

        override fun send(text: String): Boolean {
            sent += text
            val kind = (WsProtocol.decode(text) ?: error("invalid outbound frame"))::class.simpleName
                ?.lowercase()
            log?.add("send:$kind")
            return true
        }

        override fun close() {
            closed = true
        }
    }

    private class FakeScheduler : TransportScheduler {
        data class Task(
            val delayMs: Long,
            val block: () -> Unit,
            var cancelled: Boolean = false,
        ) : Cancelable {
            override fun cancel() {
                cancelled = true
            }
        }

        private val tasks = mutableListOf<Task>()

        override fun schedule(delayMs: Long, block: () -> Unit): Cancelable =
            Task(delayMs, block).also(tasks::add)

        fun activeTasks(): List<Task> = tasks.filterNot { it.cancelled }

        fun runNext() {
            val task = activeTasks().first()
            task.cancelled = true
            task.block()
        }

        fun runTaskWithDelay(delayMs: Long) {
            val task = activeTasks().first { it.delayMs == delayMs }
            task.cancelled = true
            task.block()
        }

        fun runTaskEvenIfCancelled(delayMs: Long) {
            tasks.first { it.delayMs == delayMs }.block()
        }
    }

    private class FakeCursorStore : ResumeCursorStore {
        val cursors = mutableMapOf<String, ResumeCursor>()
        val saves = mutableListOf<Pair<String, ResumeCursor>>()

        override fun load(connectionId: String): ResumeCursor? = cursors[connectionId]

        override fun save(connectionId: String, cursor: ResumeCursor) {
            cursors[connectionId] = cursor
            saves += connectionId to cursor
        }
    }

    private class FakeCredentialStore(
        private val log: MutableList<String>,
    ) : SessionCredentialStore {
        var sessionVerified = true

        override fun saveAndVerifySession(
            connectionId: String,
            expectedOldRef: String?,
            session: String,
        ): Boolean {
            log += "save-and-verify:$connectionId:$expectedOldRef:$session"
            return sessionVerified
        }

        override fun retireLegacyCredentials(connectionId: String) {
            log += "retire-legacy:$connectionId"
        }
    }

    private class FakeObserver : ProtocolObserver {
        val runtimeEvents = mutableListOf<RuntimeEventPayload>()
        val replayGaps = mutableListOf<Pair<ResumeCursor?, ResumeCursor>>()
        val protocolErrors = mutableListOf<String>()
        val transportFailures = mutableListOf<Throwable>()

        override fun onRuntimeEvent(connectionId: String, event: RuntimeEventPayload) {
            runtimeEvents += event
        }

        override fun onReplayGap(
            connectionId: String,
            previous: ResumeCursor?,
            current: ResumeCursor,
        ) {
            replayGaps += previous to current
        }

        override fun onProtocolError(connectionId: String, wire: String) {
            protocolErrors += wire
        }

        override fun onTransportFailure(connectionId: String, error: Throwable) {
            transportFailures += error
        }
    }
}
