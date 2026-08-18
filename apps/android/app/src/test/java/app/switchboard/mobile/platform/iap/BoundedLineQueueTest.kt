package app.switchboard.mobile.platform.iap

import org.junit.Assert.assertEquals
import org.junit.Test

class BoundedLineQueueTest {
    @Test
    fun `queue is FIFO and refuses an item that exceeds either bound`() {
        val queue = BoundedLineQueue(maxLines = 2, maxUtf8Bytes = 8)

        assertEquals(LineQueueOffer.Queued, queue.offer("one"))
        assertEquals(LineQueueOffer.Queued, queue.offer("two"))
        assertEquals(LineQueueOffer.Full, queue.offer("x"))
        assertEquals(listOf("one", "two"), queue.drain())
        assertEquals(emptyList<String>(), queue.drain())

        assertEquals(LineQueueOffer.Full, queue.offer("123456789"))
    }

    @Test
    fun `drop clears unsent application lines`() {
        val queue = BoundedLineQueue(maxLines = 3, maxUtf8Bytes = 32)
        queue.offer("one")
        queue.offer("two")

        queue.clear()

        assertEquals(emptyList<String>(), queue.drain())
    }
}
