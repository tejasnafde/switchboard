package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.protocol.TransportScope
import java.io.Closeable

class ThreadViewingLeaseLifecycle(
    private val expectedScope: TransportScope,
    private val threadId: String,
    private val currentScope: () -> TransportScope?,
    private val begin: (TransportScope, String) -> Closeable,
) : Closeable {
    private var activeLease: Closeable? = null
    private var closed = false

    @Synchronized
    fun onVisible() {
        acquireIfCurrent()
    }

    @Synchronized
    fun onBackground() {
        release()
    }

    @Synchronized
    fun onForegroundRenewal() {
        if (closed) return
        if (currentScope() != expectedScope) {
            release()
            return
        }
        acquireIfCurrent()
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        release()
    }

    private fun acquireIfCurrent() {
        if (closed || activeLease != null || currentScope() != expectedScope) return
        activeLease = begin(expectedScope, threadId)
    }

    private fun release() {
        activeLease?.close()
        activeLease = null
    }
}
