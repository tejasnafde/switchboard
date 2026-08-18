package app.switchboard.mobile.platform.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationRouteInboxTest {
    @Test
    fun `latest tap waits durably and is consumed exactly once`() {
        val storage = InMemoryNotificationRouteStorage()
        val firstProcess = NotificationRouteInbox(storage)
        val first = NotificationThreadRoute("machine-1", "thread-1")
        val latest = NotificationThreadRoute("machine-2", "thread-2", titleHint = "Latest")

        assertTrue(firstProcess.offer("tap-1", first))
        assertTrue(firstProcess.offer("tap-2", latest))

        val recreatedProcess = NotificationRouteInbox(storage)
        assertEquals(latest, recreatedProcess.peek()?.route)
        assertEquals(latest, recreatedProcess.consume()?.route)
        assertNull(recreatedProcess.consume())
    }

    @Test
    fun `duplicate delivery of consumed tap is not re-enqueued`() {
        val storage = InMemoryNotificationRouteStorage()
        val inbox = NotificationRouteInbox(storage)
        val route = NotificationThreadRoute("machine-1", "thread-1")

        assertTrue(inbox.offer("tap-1", route))
        assertEquals(route, inbox.consume()?.route)
        assertFalse(NotificationRouteInbox(storage).offer("tap-1", route))
        assertNull(NotificationRouteInbox(storage).peek())
    }

    @Test
    fun `failed durable write does not claim a tap was accepted`() {
        val storage = object : NotificationRouteStorage {
            override fun read() = NotificationRouteInboxState()
            override fun write(state: NotificationRouteInboxState) = false
        }

        assertFalse(
            NotificationRouteInbox(storage).offer(
                "tap-1",
                NotificationThreadRoute("machine-1", "thread-1"),
            ),
        )
    }

    @Test
    fun `untrusted tap identity is bounded before persistence`() {
        val storage = InMemoryNotificationRouteStorage()

        assertFalse(
            NotificationRouteInbox(storage).offer(
                "tap".repeat(100),
                NotificationThreadRoute("machine-1", "thread-1"),
            ),
        )
        assertNull(storage.read().pending)
    }

    private class InMemoryNotificationRouteStorage : NotificationRouteStorage {
        private var state = NotificationRouteInboxState()

        override fun read(): NotificationRouteInboxState = state

        override fun write(state: NotificationRouteInboxState): Boolean {
            this.state = state
            return true
        }
    }
}
