package app.switchboard.mobile.runtime

import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.TransportScheduler
import org.junit.Assert.assertEquals
import org.junit.Test

class TransportOutboxRetrySchedulerTest {
    @Test
    fun `rescheduling an origin cancels its older callback`() {
        val transport = FakeTransportScheduler()
        val scheduler = TransportOutboxRetryScheduler(transport)
        val calls = mutableListOf<String>()

        scheduler.schedule("origin", 10) { calls += "old" }
        scheduler.schedule("origin", 20) { calls += "new" }
        transport.runAll()

        assertEquals(listOf("new"), calls)
    }

    @Test
    fun `close cancels every pending retry and rejects future scheduling`() {
        val transport = FakeTransportScheduler()
        val scheduler = TransportOutboxRetryScheduler(transport)
        var calls = 0
        scheduler.schedule("a", 10) { calls++ }
        scheduler.schedule("b", 20) { calls++ }

        scheduler.close()
        scheduler.schedule("c", 30) { calls++ }
        transport.runAll()

        assertEquals(0, calls)
    }

    private class FakeTransportScheduler : TransportScheduler {
        private data class Task(
            var cancelled: Boolean = false,
            val callback: () -> Unit,
        )

        private val tasks = mutableListOf<Task>()

        override fun schedule(delayMs: Long, block: () -> Unit): Cancelable {
            val task = Task(callback = block)
            tasks += task
            return Cancelable { task.cancelled = true }
        }

        fun runAll() {
            tasks.toList().forEach { if (!it.cancelled) it.callback() }
        }
    }
}
