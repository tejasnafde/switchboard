package app.switchboard.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionStateMachineTest {
    private val selected = ConnectionState.selected(
        deviceId = "pixel-9",
        connectionId = "studio-mac",
        resumeCursor = ResumeCursor(epoch = "epoch-a", sequence = 40),
    )
    private val generation = selected.generation

    @Test
    fun socketOpenDoesNotPermitOutboxUntilAuthAndReadyComplete() {
        val opened = ConnectionStateMachine.reduce(
            selected,
            ConnectionEvent.SocketOpened(
                generation,
                Credential.Session("session-device-7"),
            ),
        )
        assertEquals(ConnectionPhase.Authenticating, opened.state.phase)
        assertFalse(opened.state.outboxEligible)
        assertEquals(
            listOf(ConnectionEffect.Send(WsFrame.Auth(session = "session-device-7"))),
            opened.effects,
        )

        val authed = ConnectionStateMachine.reduce(
            opened.state,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Authed.Success(session = null, scopes = listOf("provider")),
            ),
        )
        assertEquals(ConnectionPhase.AwaitingReady, authed.state.phase)
        assertFalse(authed.state.outboxEligible)
        assertEquals(
            listOf(ConnectionEffect.Send(WsFrame.Hello(selected.resumeCursor))),
            authed.effects,
        )

        val ready = ConnectionStateMachine.reduce(
            authed.state,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready(
                    "epoch-a",
                    sequence = 42,
                    replayed = 2,
                    gap = false,
                    capabilities = setOf("durable_turn_origin"),
                ),
            ),
        )
        assertEquals(ConnectionPhase.Ready, ready.state.phase)
        assertTrue(ready.state.outboxEligible)
        assertTrue(ready.state.supports("durable_turn_origin"))
        assertEquals(ResumeCursor("epoch-a", 42), ready.state.resumeCursor)
    }

    @Test
    fun legacySharedTokenSkipsFrameAuthAndWaitsForReady() {
        val opened = ConnectionStateMachine.reduce(
            selected,
            ConnectionEvent.SocketOpened(
                generation,
                Credential.LegacySharedToken("legacy-secret"),
            ),
        )

        assertEquals(ConnectionPhase.AwaitingReady, opened.state.phase)
        assertFalse(opened.state.outboxEligible)
        assertEquals(
            listOf(ConnectionEffect.Send(WsFrame.Hello(selected.resumeCursor))),
            opened.effects,
        )

        val ready = ConnectionStateMachine.reduce(
            opened.state,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready("epoch-a", sequence = 42, replayed = 0, gap = false),
            ),
        )
        assertEquals(ConnectionPhase.Ready, ready.state.phase)
        assertTrue(ready.state.outboxEligible)
    }

    @Test
    fun staleLegacyReadyCannotCompleteAReplacementGeneration() {
        val opened = ConnectionStateMachine.reduce(
            selected,
            ConnectionEvent.SocketOpened(generation, Credential.LegacySharedToken("legacy-secret")),
        ).state
        val replacement = ConnectionStateMachine.reduce(
            opened,
            ConnectionEvent.SelectConnection("tablet", "work-vm", null),
        ).state

        val stale = ConnectionStateMachine.reduce(
            replacement,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready("old", sequence = 9, replayed = 0, gap = false),
            ),
        )

        assertEquals(replacement, stale.state)
        assertTrue(stale.effects.single() is ConnectionEffect.IgnoreStale)
    }

    @Test
    fun requestResponsesAreBoundToTheCurrentDeviceConnectionAndGeneration() {
        val ready = readyState()
        val request = WsFrame.Request(
            id = 7,
            channel = "provider:send-turn",
            args = JsonArray(listOf(JsonString("thread-same"))),
        )
        val sent = ConnectionStateMachine.reduce(
            ready,
            ConnectionEvent.SendRequest(generation, request),
        )
        assertTrue(7L in sent.state.pendingRequestIds)
        assertEquals(listOf(ConnectionEffect.Send(request)), sent.effects)

        val reselected = ConnectionStateMachine.reduce(
            sent.state,
            ConnectionEvent.SelectConnection(
                deviceId = "tablet",
                connectionId = "work-vm",
                resumeCursor = null,
            ),
        ).state
        assertTrue(reselected.generation.value > generation.value)
        assertTrue(reselected.pendingRequestIds.isEmpty())

        val stale = ConnectionStateMachine.reduce(
            reselected,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Response.Success(7, JsonString("accepted")),
            ),
        )
        assertEquals(reselected, stale.state)
        assertTrue(stale.effects.single() is ConnectionEffect.IgnoreStale)
    }

    @Test
    fun reconnectGenerationRejectsLateResponsesFromThePreviousSocket() {
        val ready = readyState()
        val closed = ConnectionStateMachine.reduce(
            ready,
            ConnectionEvent.SocketClosed(generation, DisconnectCause.Network),
        ).state
        val reopenedGeneration = closed.generation
        assertTrue(reopenedGeneration.value > generation.value)

        val stale = ConnectionStateMachine.reduce(
            closed,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Response.Failure(7, "thread not found"),
            ),
        )
        assertTrue(stale.effects.single() is ConnectionEffect.IgnoreStale)
    }

    @Test
    fun acceptedEventsAdvanceTheExplicitResumeCursorAndPreservePayload() {
        val ready = readyState()
        val raw = JsonObject(
            linkedMapOf(
                "type" to JsonString("content"),
                "threadId" to JsonString("thread-same"),
                "text" to JsonString("Done"),
            ),
        )
        val received = ConnectionStateMachine.reduce(
            ready,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Event(
                    channel = "provider:event",
                    args = JsonArray(listOf(raw)),
                    sequence = 43,
                ),
            ),
        )

        assertEquals(ResumeCursor("epoch-a", 43), received.state.resumeCursor)
        val delivered = received.effects.single() as ConnectionEffect.DeliverRuntimeEvent
        assertEquals(raw, delivered.event.raw)
    }

    @Test
    fun replayGapIsExplicitAndServiceDestructionReturnsSafeState() {
        val awaitingReady = selected.copy(phase = ConnectionPhase.AwaitingReady)
        val gap = ConnectionStateMachine.reduce(
            awaitingReady,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready("epoch-b", sequence = 3, replayed = 0, gap = true),
            ),
        )
        assertTrue(gap.effects.single() is ConnectionEffect.ReplayGap)
        assertEquals(ResumeCursor("epoch-b", 3), gap.state.resumeCursor)

        val destroyed = ConnectionStateMachine.reduce(gap.state, ConnectionEvent.ServiceDestroyed)
        assertEquals(ConnectionPhase.Disconnected, destroyed.state.phase)
        assertFalse(destroyed.state.outboxEligible)
        assertTrue(destroyed.state.pendingRequestIds.isEmpty())
    }

    @Test
    fun replayEventsBeforeReadyAreHeldThenReleasedInFifoOrder() {
        val awaitingReady = awaitingReadyState()
        val first = runtimeEventFrame(sequence = 41, text = "first")
        val second = runtimeEventFrame(sequence = 42, text = "second")

        val heldFirst = ConnectionStateMachine.reduce(
            awaitingReady,
            ConnectionEvent.FrameReceived(generation, first),
        )
        val heldSecond = ConnectionStateMachine.reduce(
            heldFirst.state,
            ConnectionEvent.FrameReceived(generation, second),
        )

        assertTrue(heldFirst.effects.isEmpty())
        assertTrue(heldSecond.effects.isEmpty())
        assertEquals(listOf(first, second), heldSecond.state.heldReplayEvents)

        val ready = ConnectionStateMachine.reduce(
            heldSecond.state,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready("epoch-a", sequence = 42, replayed = 2, gap = false),
            ),
        )

        assertTrue(ready.state.heldReplayEvents.isEmpty())
        assertEquals(
            listOf("first", "second"),
            ready.effects.map {
                val delivered = it as ConnectionEffect.DeliverRuntimeEvent
                delivered.event.raw.requireString("text")
            },
        )
    }

    @Test
    fun replayGapDiscardsHeldEventsAndLifecycleBoundariesClearThem() {
        val replay = runtimeEventFrame(sequence = 41, text = "stale replay")
        val held = ConnectionStateMachine.reduce(
            awaitingReadyState(),
            ConnectionEvent.FrameReceived(generation, replay),
        ).state
        assertEquals(listOf(replay), held.heldReplayEvents)

        val gap = ConnectionStateMachine.reduce(
            held,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready("epoch-b", sequence = 3, replayed = 0, gap = true),
            ),
        )
        assertTrue(gap.state.heldReplayEvents.isEmpty())
        assertEquals(1, gap.effects.size)
        assertTrue(gap.effects.single() is ConnectionEffect.ReplayGap)

        val heldForClose = held.copy()
        val closed = ConnectionStateMachine.reduce(
            heldForClose,
            ConnectionEvent.SocketClosed(generation, DisconnectCause.Network),
        ).state
        assertTrue(closed.heldReplayEvents.isEmpty())

        val selected = ConnectionStateMachine.reduce(
            held,
            ConnectionEvent.SelectConnection("tablet", "work-vm", null),
        ).state
        assertTrue(selected.heldReplayEvents.isEmpty())

        val destroyed = ConnectionStateMachine.reduce(held, ConnectionEvent.ServiceDestroyed).state
        assertTrue(destroyed.heldReplayEvents.isEmpty())
    }

    @Test
    fun retryBackoffIsPureBoundedAndCauseAware() {
        assertEquals(RetryDecision.After(1_000), RetryPolicy.decide(DisconnectCause.Network, 0))
        assertEquals(RetryDecision.After(16_000), RetryPolicy.decide(DisconnectCause.Network, 20))
        assertEquals(RetryDecision.Stop, RetryPolicy.decide(DisconnectCause.AuthenticationRejected, 0))
        assertEquals(RetryDecision.Stop, RetryPolicy.decide(DisconnectCause.UserRequested, 0))
        assertEquals(RetryDecision.Stop, RetryPolicy.decide(DisconnectCause.ServiceDestroyed, 0))
    }

    private fun readyState(): ConnectionState {
        val authed = awaitingReadyState()
        return ConnectionStateMachine.reduce(
            authed,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Ready("epoch-a", sequence = 42, replayed = 2, gap = false),
            ),
        ).state
    }

    private fun awaitingReadyState(): ConnectionState {
        val opened = ConnectionStateMachine.reduce(
            selected,
            ConnectionEvent.SocketOpened(generation, Credential.Session("session-device-7")),
        ).state
        return ConnectionStateMachine.reduce(
            opened,
            ConnectionEvent.FrameReceived(
                generation,
                WsFrame.Authed.Success(session = null, scopes = listOf("provider")),
            ),
        ).state
    }

    private fun runtimeEventFrame(sequence: Long, text: String): WsFrame.Event {
        val raw = JsonObject(
            linkedMapOf(
                "type" to JsonString("content"),
                "threadId" to JsonString("thread-same"),
                "text" to JsonString(text),
            ),
        )
        return WsFrame.Event(
            channel = "provider:event",
            args = JsonArray(listOf(raw)),
            sequence = sequence,
        )
    }
}
