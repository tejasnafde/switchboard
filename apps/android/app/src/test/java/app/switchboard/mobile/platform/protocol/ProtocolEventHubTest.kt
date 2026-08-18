package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventKind
import app.switchboard.mobile.protocol.RuntimeEventPayload
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolEventHubTest {
    private val scopeA = TransportScope("device", "a", 7)
    private val scopeB = TransportScope("device", "b", 8)

    @Test
    fun scopedEventsPreserveConnectionRuntimePayloadAndExactReplayCursors() = runBlocking {
        val hub = ProtocolEventHub(bufferCapacity = 4)
        val received = mutableListOf<ProtocolHubEvent>()
        val collection = launch(start = CoroutineStart.UNDISPATCHED) {
            hub.eventsFor(scopeA).take(2).toList(received)
        }
        val runtime = runtime("thread-a")
        val previous = ResumeCursor("old", null)
        val current = ResumeCursor("new", 42)

        hub.onRuntimeEvent(scopeA.copy(generation = 6), runtime("ignored-stale-generation"))
        hub.onRuntimeEvent(scopeA, runtime)
        hub.onReplayGap(scopeA, previous, current)
        collection.join()

        assertEquals(ProtocolHubEvent.Runtime(scopeA, runtime), received[0])
        assertEquals(ProtocolHubEvent.ReplayGap(scopeA, previous, current), received[1])
    }

    @Test
    fun rawProtocolFramesAndThrowableMessagesNeverEnterEventsOrHealth() = runBlocking {
        val hub = ProtocolEventHub(bufferCapacity = 4)
        val received = mutableListOf<ProtocolHubEvent>()
        val collection = launch(start = CoroutineStart.UNDISPATCHED) {
            hub.events.take(2).toList(received)
        }
        val secret = "token=never-store-this"

        val scope = TransportScope("device", "machine", 9)
        hub.onProtocolError(scope, "{\"k\":\"auth\",\"$secret\":true}")
        hub.onTransportFailure(scope, IllegalStateException("wss://host/?$secret"))
        collection.join()

        assertEquals(
            listOf(
                ProtocolHubEvent.ProtocolError(scope),
                ProtocolHubEvent.TransportFailure(scope),
            ),
            received,
        )
        assertFalse(received.toString().contains(secret))
        assertFalse(hub.health.value.toString().contains(secret))
        assertEquals(ProtocolHubEventCategory.TransportFailure, hub.health.value.lastErrorCategory)
        assertEquals("machine", hub.health.value.lastErrorConnectionId)
    }

    @Test
    fun aSlowSubscriberCannotGrowMemoryAndOverflowIsVisible() = runBlocking {
        val hub = ProtocolEventHub(bufferCapacity = 1)
        val consumingFirst = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val collection = launch(start = CoroutineStart.UNDISPATCHED) {
            hub.events.collect {
                consumingFirst.complete(Unit)
                release.await()
            }
        }

        hub.onRuntimeEvent(scopeA, runtime("first"))
        consumingFirst.await()
        hub.onRuntimeEvent(scopeA, runtime("buffered"))
        hub.onRuntimeEvent(scopeB, runtime("dropped"))

        assertEquals(1, hub.health.value.droppedEventCount)
        assertEquals("b", hub.health.value.lastOverflowConnectionId)
        assertEquals(ProtocolHubEventCategory.Runtime, hub.health.value.lastOverflowCategory)
        release.complete(Unit)
        collection.cancelAndJoin()
    }

    @Test
    fun closeIsVisibleAndRejectsFurtherEvents() {
        val hub = ProtocolEventHub(bufferCapacity = 1)

        hub.close()
        hub.onProtocolError(scopeA, "secret")

        assertTrue(hub.health.value.closed)
        assertEquals(null, hub.health.value.lastErrorConnectionId)
    }

    private fun runtime(threadId: String) = RuntimeEventPayload(
        type = "content",
        threadId = threadId,
        kind = RuntimeEventKind.Known,
        raw = JsonObject(linkedMapOf("type" to JsonString("content"), "threadId" to JsonString(threadId))),
    )
}
