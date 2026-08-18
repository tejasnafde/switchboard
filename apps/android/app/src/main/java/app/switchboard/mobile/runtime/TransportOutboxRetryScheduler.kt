package app.switchboard.mobile.runtime

import app.switchboard.mobile.data.outbox.OutboxRetryScheduler
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.TransportScheduler
import java.io.Closeable

class TransportOutboxRetryScheduler(
    private val scheduler: TransportScheduler,
) : OutboxRetryScheduler, Closeable {
    private class Pending(
        var cancelable: Cancelable? = null,
    )

    private val pending = mutableMapOf<String, Pending>()
    private var closed = false

    @Synchronized
    override fun schedule(origin: String, delayMs: Long, callback: () -> Unit) {
        if (closed) return
        pending.remove(origin)?.cancelable?.cancel()
        val entry = Pending()
        pending[origin] = entry
        val cancelable = scheduler.schedule(delayMs) {
            val shouldRun = synchronized(this) {
                if (closed || pending[origin] !== entry) {
                    false
                } else {
                    pending.remove(origin)
                    true
                }
            }
            if (shouldRun) callback()
        }
        if (pending[origin] === entry) {
            entry.cancelable = cancelable
        } else {
            cancelable.cancel()
        }
    }

    @Synchronized
    override fun cancel(origin: String) {
        pending.remove(origin)?.cancelable?.cancel()
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        pending.values.forEach { it.cancelable?.cancel() }
        pending.clear()
    }
}
