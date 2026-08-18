package app.switchboard.mobile.domain.push

import app.switchboard.mobile.platform.protocol.TransportScope
import java.io.Closeable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistrationCoordinatorTest {
    @Test
    fun `ready scope registers once and reconnect registers the replacement scope`() {
        val coordinator = PushRegistrationCoordinator()
        val first = FakeBackend(scope(1))
        coordinator.onExpoToken("ExpoPushToken[token-a]")

        coordinator.onReady(listOf(first))
        coordinator.onReady(listOf(first))
        assertEquals(listOf("register:ExpoPushToken[token-a]:phone:mac-a"), first.calls)
        first.complete(PushBackendResult.Accepted)
        coordinator.onReady(listOf(first))
        assertEquals(1, first.calls.size)

        val replacement = FakeBackend(scope(2))
        coordinator.onReady(listOf(replacement))
        assertEquals(listOf("register:ExpoPushToken[token-a]:phone:mac-a"), replacement.calls)
    }

    @Test
    fun `token rotation unregisters old token before registering new and fences stale callbacks`() {
        val coordinator = PushRegistrationCoordinator()
        val backend = FakeBackend(scope(7))
        coordinator.onExpoToken("ExpoPushToken[old]")
        coordinator.onReady(listOf(backend))

        coordinator.onExpoToken("ExpoPushToken[new]")
        assertEquals(
            listOf(
                "register:ExpoPushToken[old]:phone:mac-a",
                "unregister:ExpoPushToken[old]",
                "register:ExpoPushToken[new]:phone:mac-a",
            ),
            backend.calls,
        )
        backend.completeAt(0, PushBackendResult.Accepted)
        backend.completeAt(2, PushBackendResult.Accepted)
        coordinator.onReady(listOf(backend))
        assertEquals(3, backend.calls.size)
    }

    @Test
    fun `domain rejection and missing old backend are nonfatal and retryable`() {
        val coordinator = PushRegistrationCoordinator()
        val backend = FakeBackend(scope(3))
        coordinator.onExpoToken("ExpoPushToken[token]")
        coordinator.onReady(listOf(backend))
        backend.complete(PushBackendResult.Rejected("No handler registered"))

        coordinator.onReady(listOf(backend))
        assertEquals(2, backend.calls.count { it.startsWith("register:") })
        backend.complete(PushBackendResult.TransportFailure("closed"))
        coordinator.onReady(emptyList())
        assertTrue(true)
    }

    @Test
    fun `remove unregisters while exact backend is still available`() {
        val coordinator = PushRegistrationCoordinator()
        val backend = FakeBackend(scope(4))
        coordinator.onExpoToken("ExpoPushToken[token]")
        coordinator.onReady(listOf(backend))
        backend.complete(PushBackendResult.Accepted)

        coordinator.beforeConnectionRemoved("mac-a")

        assertEquals("unregister:ExpoPushToken[token]", backend.calls.last())
    }

    @Test
    fun `viewing enter renew leave stay on exact token and replacement scope`() {
        val coordinator = PushRegistrationCoordinator()
        val first = FakeBackend(scope(10))
        coordinator.onExpoToken("ExpoPushToken[token]")
        coordinator.onReady(listOf(first))
        val lease: Closeable = coordinator.beginViewing("mac-a", "thread-1")

        assertEquals("viewing:ExpoPushToken[token]:thread-1", first.calls.last())
        coordinator.renewViewingLeases()
        assertEquals(2, first.calls.count { it == "viewing:ExpoPushToken[token]:thread-1" })

        val replacement = FakeBackend(scope(11))
        coordinator.onReady(listOf(replacement))
        assertEquals("viewing:ExpoPushToken[token]:thread-1", replacement.calls.last())
        lease.close()
        assertEquals("viewing:ExpoPushToken[token]:null", replacement.calls.last())
        assertTrue(first.calls.none { it == "viewing:ExpoPushToken[token]:null" })
    }

    private class FakeBackend(
        override val scope: TransportScope,
    ) : PushBackend {
        data class Pending(val callback: (PushBackendResult) -> Unit)

        val calls = mutableListOf<String>()
        private val pending = mutableListOf<Pending>()

        override fun register(
            token: String,
            label: String,
            clientRef: String,
            callback: (PushBackendResult) -> Unit,
        ) {
            calls += "register:$token:$label:$clientRef"
            pending += Pending(callback)
        }

        override fun unregister(token: String, callback: (PushBackendResult) -> Unit) {
            calls += "unregister:$token"
            pending += Pending(callback)
        }

        override fun reportViewing(
            token: String,
            threadId: String?,
            callback: (PushBackendResult) -> Unit,
        ) {
            calls += "viewing:$token:$threadId"
            pending += Pending(callback)
        }

        fun complete(result: PushBackendResult) = pending.last().callback(result)

        fun completeAt(index: Int, result: PushBackendResult) = pending[index].callback(result)
    }

    private fun scope(generation: Long) = TransportScope("phone", "mac-a", generation)
}
