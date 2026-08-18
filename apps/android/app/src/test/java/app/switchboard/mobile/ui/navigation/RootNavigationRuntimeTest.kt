package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RootNavigationRuntimeTest {
    @Test
    fun `connecting or nominally connected without a lease stays loading`() {
        assertEquals(
            LeaseFallback.Loading,
            RootNavigationPolicy.fallback(
                ConnectionRuntimeState(2, ConnectionStatus.Connecting, ""),
            ),
        )
        assertEquals(
            LeaseFallback.Loading,
            RootNavigationPolicy.fallback(
                ConnectionRuntimeState(2, ConnectionStatus.Connected, ""),
            ),
        )
    }

    @Test
    fun `offline and error states expose a real retry`() {
        assertEquals(
            LeaseFallback.Retryable("Machine is offline"),
            RootNavigationPolicy.fallback(
                ConnectionRuntimeState(2, ConnectionStatus.Disconnected, ""),
            ),
        )
        assertEquals(
            LeaseFallback.Retryable("Pairing was rejected"),
            RootNavigationPolicy.fallback(
                ConnectionRuntimeState(2, ConnectionStatus.Error, "Pairing was rejected"),
            ),
        )
    }

    @Test
    fun `protocol runtime bridge attaches only events from the exact active lease`() = runBlocking {
        val events = MutableSharedFlow<ProtocolHubEvent>(extraBufferCapacity = 4)
        val expectedTransport = TransportScope("device", "machine", 7)
        val expected = ThreadEventScope("machine", 7)
        var current = true
        val received = mutableListOf<Pair<ThreadEventScope, RuntimeEventPayload>>()
        val bridge = ProtocolRuntimeEventBridge(
            scope = this,
            expectedScope = expectedTransport,
            events = events,
            isLeaseCurrent = { current },
        )
        val subscription = bridge.subscribe { scope, event -> received += scope to event }
        val collectorStarted = launch(start = CoroutineStart.UNDISPATCHED) { kotlinx.coroutines.yield() }
        collectorStarted.join()

        events.emit(
            ProtocolHubEvent.Runtime(
                TransportScope("other-device", "other", 7),
                runtime("ignored"),
            ),
        )
        events.emit(ProtocolHubEvent.Runtime(expectedTransport, runtime("accepted")))
        kotlinx.coroutines.yield()
        current = false
        events.emit(ProtocolHubEvent.Runtime(expectedTransport, runtime("stale")))
        kotlinx.coroutines.yield()

        assertEquals(listOf(expected to runtime("accepted")), received)
        subscription.cancel()
        assertTrue(received.size == 1)
    }

    private fun runtime(threadId: String): RuntimeEventPayload {
        val raw = JsonObject(
            linkedMapOf(
                "type" to JsonString("status"),
                "threadId" to JsonString(threadId),
                "status" to JsonString("running"),
            ),
        )
        return RuntimeEventPayload.parse(raw)!!
    }
}
