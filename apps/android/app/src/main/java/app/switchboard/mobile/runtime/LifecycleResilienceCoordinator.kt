package app.switchboard.mobile.runtime

import app.switchboard.mobile.domain.connection.ConnectionLifecycle
import app.switchboard.mobile.domain.connection.ForegroundAction
import java.io.Closeable

class ViewingLeaseRenewalHooks {
    private val callbacks = linkedSetOf<() -> Unit>()

    @Synchronized
    fun register(callback: () -> Unit): Closeable {
        callbacks += callback
        return Closeable { synchronized(this) { callbacks -= callback } }
    }

    fun renewAll() {
        val snapshot = synchronized(this) { callbacks.toList() }
        snapshot.forEach { callback -> runCatching(callback) }
    }
}

class LifecycleResilienceCoordinator(
    private val clock: () -> Long,
    private val onNetworkChanged: (Boolean) -> Unit,
    private val onForegroundAction: (ForegroundAction) -> Unit,
    private val wakeOutbox: () -> Unit,
    private val renewViewingLeases: () -> Unit,
) {
    private var backgroundedAtMs: Long? = null
    private var foreground = false
    private var networkAvailable: Boolean? = null

    fun onBackground() {
        synchronized(this) {
            if (!foreground && backgroundedAtMs != null) return
            foreground = false
            backgroundedAtMs = clock()
        }
    }

    fun onForeground() {
        val action = synchronized(this) {
            if (foreground) return
            foreground = true
            ConnectionLifecycle.foregroundAction(backgroundedAtMs, clock()).also {
                backgroundedAtMs = null
            }
        }
        runCatching(renewViewingLeases)
        runCatching(wakeOutbox)
        runCatching { onForegroundAction(action) }
    }

    fun onNetworkAvailability(available: Boolean) {
        val previous = synchronized(this) {
            val current = networkAvailable
            if (current == available) return
            networkAvailable = available
            current
        }
        runCatching { onNetworkChanged(available) }
        if (previous == false && available) runCatching(wakeOutbox)
    }
}
