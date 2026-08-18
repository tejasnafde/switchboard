package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.domain.connection.ConnectionRuntimeEvent
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import app.switchboard.mobile.protocol.WsProtocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthenticatedConnectionFleetCoordinatorFactoryTest {
    @Test
    fun authenticationFailureCannotBeOverwrittenByItsDeliberateCloseCallback() {
        val fixture = Fixture()
        val coordinator = fixture.create()
        coordinator.connect(target())
        val call = fixture.dialer.calls.single()
        call.callbacks.onOpen(call.socket)

        call.callbacks.onText(WsProtocol.encode(WsFrame.Authed.Failure("rejected")))
        call.callbacks.onClosed(DisconnectCause.Network)

        assertEquals(
            listOf(ConnectionRuntimeEvent.Stopped(FLEET_GENERATION, authenticationRejected = true)),
            fixture.events,
        )
        assertEquals(null, coordinator.endpoint)
    }

    @Test
    fun staleAttemptFailureAfterNewerReadyIsIgnoredBeforeItTouchesTheCoordinator() {
        val fixture = Fixture()
        val coordinator = fixture.create()
        coordinator.connect(target())
        val first = fixture.dialer.calls.single()
        first.callbacks.onOpen(first.socket)
        first.callbacks.onClosed(DisconnectCause.Network)
        fixture.scheduler.runNext()

        val second = fixture.dialer.calls.last()
        second.callbacks.onOpen(second.socket)
        second.callbacks.onText(
            WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
        )
        second.callbacks.onText(
            WsProtocol.encode(
                WsFrame.Ready(
                    epoch = "epoch",
                    sequence = 3,
                    replayed = 0,
                    gap = false,
                    capabilities = setOf("durable_turn_origin"),
                ),
            ),
        )
        val readyEvents = fixture.events.toList()
        val endpoint = coordinator.endpoint

        first.callbacks.onFailure(IllegalStateException("late old socket"))

        assertEquals(readyEvents, fixture.events)
        assertNotNull(endpoint)
        assertEquals(endpoint, coordinator.endpoint)
        assertEquals(setOf("durable_turn_origin"), coordinator.endpoint?.capabilities)
        assertTrue(second.socket.closed.not())
    }

    @Test
    fun firstDialsOfTwoFleetRebuildsExposeDifferentLeaseScopes() {
        val fixture = Fixture()
        val first = fixture.create(generation = 41)
        first.connect(target())
        fixture.ready(fixture.dialer.calls.last())

        val second = fixture.create(generation = 42)
        second.connect(target())
        fixture.ready(fixture.dialer.calls.last())

        assertEquals(41L, first.endpoint?.scope?.generation)
        assertEquals(42L, second.endpoint?.scope?.generation)
        assertTrue(first.endpoint?.scope != second.endpoint?.scope)
    }

    @Test
    fun leasedRpcRejectsTheWrongExternalScopeBeforeTranslatingToTheCoordinator() {
        val fixture = Fixture()
        val coordinator = fixture.create()
        coordinator.connect(target())
        val call = fixture.dialer.calls.single()
        fixture.ready(call)
        val endpoint = requireNotNull(coordinator.endpoint)
        val sendsBefore = call.socket.sent.size
        val outcomes = mutableListOf<RpcOutcome>()

        val submission = endpoint.rpc.invoke(
            endpoint.scope.copy(generation = endpoint.scope.generation + 1),
            "app:get-projects",
            JsonArray(emptyList()),
            outcomes::add,
        )

        assertEquals(RequestSubmission.Rejected(RpcFailure.ConnectionReplaced), submission)
        assertEquals(listOf(RpcOutcome.Failure(RpcFailure.ConnectionReplaced)), outcomes)
        assertEquals(sendsBefore, call.socket.sent.size)
    }

    @Test
    fun `observer events retain the fleet lease generation that produced them`() {
        val fixture = Fixture()
        val first = fixture.create(generation = 41)
        first.connect(target())
        val firstCall = fixture.dialer.calls.last()
        fixture.ready(firstCall)
        firstCall.callbacks.onText(WsProtocol.encode(runtimeFrame("from-old")))

        val second = fixture.create(generation = 42)
        second.connect(target())
        val secondCall = fixture.dialer.calls.last()
        fixture.ready(secondCall)
        secondCall.callbacks.onText(WsProtocol.encode(runtimeFrame("from-new")))

        assertEquals(listOf(41L, 42L), fixture.runtimeScopes.map { it.generation })
        assertEquals(listOf("from-old", "from-new"), fixture.runtimeEvents.map { it.threadId })
    }

    private class Fixture {
        val dialer = FakeDialer()
        val scheduler = FakeScheduler()
        val events = mutableListOf<ConnectionRuntimeEvent>()
        val runtimeScopes = mutableListOf<TransportScope>()
        val runtimeEvents = mutableListOf<RuntimeEventPayload>()

        fun create(generation: Long = FLEET_GENERATION) = AuthenticatedConnectionFleetCoordinatorFactory(
            dialer = dialer,
            scheduler = scheduler,
            cursorStore = object : ResumeCursorStore {
                override fun load(connectionId: String): ResumeCursor? = null
                override fun save(connectionId: String, cursor: ResumeCursor) = Unit
            },
            credentialStore = object : SessionCredentialStore {
                override fun saveAndVerifySession(
                    connectionId: String,
                    expectedOldRef: String?,
                    session: String,
                ) = true
                override fun retireLegacyCredentials(connectionId: String) = Unit
            },
            observer = object : ScopedProtocolObserver {
                override fun onRuntimeEvent(scope: TransportScope, event: RuntimeEventPayload) {
                    runtimeScopes += scope
                    runtimeEvents += event
                }
                override fun onReplayGap(
                    scope: TransportScope,
                    previous: ResumeCursor?,
                    current: ResumeCursor,
                ) = Unit
                override fun onProtocolError(scope: TransportScope, wire: String) = Unit
            },
        ).create("machine", generation, events::add)

        fun ready(call: FakeDialer.Call) {
            call.callbacks.onOpen(call.socket)
            call.callbacks.onText(
                WsProtocol.encode(WsFrame.Authed.Success(session = null, scopes = listOf("provider"))),
            )
            call.callbacks.onText(
                WsProtocol.encode(WsFrame.Ready("epoch", 0, replayed = 0, gap = false)),
            )
        }
    }

    private class FakeDialer : WebSocketDialer {
        data class Call(
            val callbacks: WebSocketCallbacks,
            val socket: FakeSocket = FakeSocket(),
        )

        val calls = mutableListOf<Call>()

        override fun open(target: WebSocketTarget, callbacks: WebSocketCallbacks): WebSocketConnection =
            Call(callbacks).also(calls::add).socket
    }

    private class FakeSocket : WebSocketConnection {
        var closed = false
        val sent = mutableListOf<String>()
        override fun send(text: String): Boolean {
            sent += text
            return true
        }
        override fun close() {
            closed = true
        }
    }

    private class FakeScheduler : TransportScheduler {
        private data class Task(
            val block: () -> Unit,
            var cancelled: Boolean = false,
        ) : Cancelable {
            override fun cancel() {
                cancelled = true
            }
        }

        private val tasks = mutableListOf<Task>()

        override fun schedule(delayMs: Long, block: () -> Unit): Cancelable =
            Task(block).also(tasks::add)

        fun runNext() {
            val task = tasks.first { !it.cancelled }
            task.cancelled = true
            task.block()
        }
    }

    private fun target() = WebSocketTarget(
        deviceId = "phone",
        connectionId = "machine",
        url = "wss://machine",
        credential = Credential.Session("secret"),
    )

    private fun runtimeFrame(threadId: String) = WsFrame.Event(
        channel = "provider:event",
        args = JsonArray(
            listOf(
                JsonObject(
                    linkedMapOf(
                        "type" to JsonString("status"),
                        "threadId" to JsonString(threadId),
                        "status" to JsonString("running"),
                    ),
                ),
            ),
        ),
        sequence = null,
    )

    private companion object {
        const val FLEET_GENERATION = 41L
    }
}
