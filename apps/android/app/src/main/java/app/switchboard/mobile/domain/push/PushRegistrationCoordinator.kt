package app.switchboard.mobile.domain.push

import app.switchboard.mobile.platform.protocol.TransportScope
import java.io.Closeable

sealed interface PushBackendResult {
    data object Accepted : PushBackendResult

    data class Rejected(val reason: String) : PushBackendResult

    data class TransportFailure(val reason: String) : PushBackendResult
}

interface PushBackend {
    val scope: TransportScope

    fun register(
        token: String,
        label: String,
        clientRef: String,
        callback: (PushBackendResult) -> Unit,
    )

    fun unregister(token: String, callback: (PushBackendResult) -> Unit)

    fun reportViewing(
        token: String,
        threadId: String?,
        callback: (PushBackendResult) -> Unit,
    )
}

class PushRegistrationCoordinator {
    private data class RegistrationKey(
        val token: String,
        val scope: TransportScope,
    )

    private data class ViewingLease(
        val id: Long,
        val scope: TransportScope,
        val threadId: String,
    )

    private var token: String? = null
    private var ready = emptyMap<String, PushBackend>()
    private val registered = mutableSetOf<RegistrationKey>()
    private val registering = mutableSetOf<RegistrationKey>()
    private val viewing = mutableMapOf<String, ViewingLease>()
    private var nextViewingId = 0L

    @Synchronized
    fun onExpoToken(nextToken: String) {
        if (!ExpoPushTokenContract.isExpoPushToken(nextToken) || token == nextToken) return
        val previousToken = token
        token = nextToken
        registered.clear()
        registering.clear()
        if (previousToken != null) {
            ready.values.forEach { backend ->
                backend.unregister(previousToken) { }
            }
        }
        ready.values.forEach(::registerIfNeeded)
        viewing.forEach { (connectionId, lease) ->
            ready[connectionId]
                ?.takeIf { it.scope == lease.scope }
                ?.let { reportViewing(it, nextToken, lease.threadId) }
        }
    }

    @Synchronized
    fun onReady(backends: List<PushBackend>) {
        val previous = ready
        ready = backends
            .filter { it.scope.connectionId.isNotBlank() }
            .associateBy { it.scope.connectionId }
        val scopes = ready.values.mapTo(mutableSetOf()) { it.scope }
        registered.removeAll { it.scope !in scopes }
        registering.removeAll { it.scope !in scopes }
        ready.values.forEach(::registerIfNeeded)
        val currentToken = token ?: return
        viewing.forEach { (connectionId, lease) ->
            val backend = ready[connectionId] ?: return@forEach
            if (
                backend.scope == lease.scope &&
                previous[connectionId]?.scope != backend.scope
            ) {
                reportViewing(backend, currentToken, lease.threadId)
            }
        }
    }

    @Synchronized
    fun beforeConnectionRemoved(connectionId: String) {
        val backend = ready[connectionId] ?: return
        ready = ready - connectionId
        val lease = viewing.remove(connectionId)
        registered.removeAll { it.scope == backend.scope }
        registering.removeAll { it.scope == backend.scope }
        val currentToken = token ?: return
        if (lease?.scope == backend.scope) {
            reportViewing(backend, currentToken, threadId = null)
        }
        backend.unregister(currentToken) { }
    }

    @Synchronized
    fun beginViewing(connectionId: String, threadId: String): Closeable {
        val scope = ready[connectionId]?.scope ?: return Closeable {}
        return beginViewing(scope, threadId)
    }

    @Synchronized
    fun beginViewing(scope: TransportScope, threadId: String): Closeable {
        if (scope.connectionId.isBlank() || threadId.isBlank()) return Closeable {}
        val connectionId = scope.connectionId
        val backend = ready[connectionId]
        if (backend != null && backend.scope != scope) return Closeable {}
        val lease = ViewingLease(++nextViewingId, scope, threadId)
        viewing[connectionId] = lease
        val currentToken = token
        if (currentToken != null && backend != null) {
            reportViewing(backend, currentToken, threadId)
        }
        return Closeable { endViewing(connectionId, lease.id) }
    }

    @Synchronized
    fun renewViewingLeases() {
        val currentToken = token ?: return
        viewing.forEach { (connectionId, lease) ->
            ready[connectionId]
                ?.takeIf { it.scope == lease.scope }
                ?.let { reportViewing(it, currentToken, lease.threadId) }
        }
    }

    @Synchronized
    private fun endViewing(connectionId: String, leaseId: Long) {
        val current = viewing[connectionId] ?: return
        if (current.id != leaseId) return
        viewing.remove(connectionId)
        val currentToken = token ?: return
        ready[connectionId]
            ?.takeIf { it.scope == current.scope }
            ?.let { reportViewing(it, currentToken, threadId = null) }
    }

    private fun registerIfNeeded(backend: PushBackend) {
        val currentToken = token ?: return
        val key = RegistrationKey(currentToken, backend.scope)
        if (key in registered || !registering.add(key)) return
        backend.register(currentToken, PHONE_LABEL, backend.scope.connectionId) { result ->
            synchronized(this) {
                registering -= key
                if (
                    result == PushBackendResult.Accepted &&
                    token == key.token &&
                    ready[key.scope.connectionId]?.scope == key.scope
                ) {
                    registered += key
                }
            }
        }
    }

    private fun reportViewing(backend: PushBackend, token: String, threadId: String?) {
        backend.reportViewing(token, threadId) { }
    }

    private companion object {
        const val PHONE_LABEL = "phone"
    }
}
