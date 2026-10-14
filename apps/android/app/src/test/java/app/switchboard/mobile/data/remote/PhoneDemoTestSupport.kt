package app.switchboard.mobile.data.remote

import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.TransportScheduler
import java.io.File
import java.util.PriorityQueue

/** The shared fixture, read from the repo the way the APK packs it. */
object PhoneDemoTestFixture {
    val file: File = listOf(
        File("../../../src/shared/phone-demo/fixture/phone-demo.json"),
        File("../../src/shared/phone-demo/fixture/phone-demo.json"),
    ).first(File::exists)

    fun json(): String = file.readText()

    const val NOW = 1_800_000_000_000L
}

/** A virtual clock: tasks run only when the test advances time, in time then submit order. */
class VirtualScheduler : TransportScheduler {
    private class Task(val at: Long, val order: Long, val block: () -> Unit) {
        var cancelled = false
    }

    var now = 0L
        private set
    private var order = 0L
    private val tasks = PriorityQueue<Task>(compareBy<Task>({ it.at }, { it.order }))

    override fun schedule(delayMs: Long, block: () -> Unit): Cancelable {
        val task = Task(now + delayMs, order++, block)
        tasks += task
        return Cancelable { task.cancelled = true }
    }

    fun advanceBy(ms: Long) {
        val target = now + ms
        while (true) {
            val next = tasks.peek() ?: break
            if (next.at > target) break
            tasks.poll()
            now = next.at
            if (!next.cancelled) next.block()
        }
        now = target
    }

    fun pending(): Int = tasks.count { !it.cancelled }
}
