package app.switchboard.mobile.runtime

import app.switchboard.mobile.domain.connection.ConnectionLifecycle
import app.switchboard.mobile.domain.connection.ForegroundAction
import app.switchboard.mobile.platform.log.SbLog
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
    private val onNetworkRouteChanged: () -> Unit = {},
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
        SbLog.i(LOG_SCOPE, "background")
    }

    fun onForeground() {
        val (action, awayMs) = synchronized(this) {
            if (foreground) return
            foreground = true
            val now = clock()
            val away = backgroundedAtMs?.let { now - it }
            ConnectionLifecycle.foregroundAction(backgroundedAtMs, now).also {
                backgroundedAtMs = null
            } to away
        }
        SbLog.i(LOG_SCOPE, "foreground after ${awayMs ?: "-"} ms: $action")
        runLogged("renew viewing leases", renewViewingLeases)
        runLogged("wake outbox", wakeOutbox)
        runLogged("foreground action") { onForegroundAction(action) }
    }

    fun onNetworkAvailability(available: Boolean) {
        val previous = synchronized(this) {
            val current = networkAvailable
            if (current == available) return
            networkAvailable = available
            current
        }
        SbLog.i(LOG_SCOPE, "network available=$available (was $previous)")
        runLogged("network change") { onNetworkChanged(available) }
        if (previous == false && available) runLogged("wake outbox", wakeOutbox)
    }

    /** The default network moved while still connected; a foreground app checks its sockets. */
    fun onNetworkRoute() {
        val visible = synchronized(this) { foreground }
        // In the background the process is about to be frozen, and the next
        // foreground return checks the sockets anyway.
        SbLog.i(LOG_SCOPE, "network route changed, foreground=$visible")
        if (visible) runLogged("network route", onNetworkRouteChanged)
    }

    private fun runLogged(step: String, block: () -> Unit) {
        try {
            block()
        } catch (error: Throwable) {
            SbLog.w(LOG_SCOPE, "$step threw ${SbLog.describe(error)}")
        }
    }

    private companion object {
        const val LOG_SCOPE = "lifecycle"
    }
}
