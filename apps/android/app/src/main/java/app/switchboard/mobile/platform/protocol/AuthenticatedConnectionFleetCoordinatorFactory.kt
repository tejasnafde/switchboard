package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.data.connection.ConnectionFleetCoordinator
import app.switchboard.mobile.data.connection.ConnectionFleetCoordinatorFactory
import app.switchboard.mobile.data.connection.ConnectionFleetEndpoint
import app.switchboard.mobile.data.remote.RemoteRpc
import app.switchboard.mobile.domain.connection.ConnectionRuntimeEvent
import app.switchboard.mobile.protocol.ConnectionPhase
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import app.switchboard.mobile.protocol.WsProtocol
import java.util.concurrent.atomic.AtomicInteger

class AuthenticatedConnectionFleetCoordinatorFactory(
    private val dialer: WebSocketDialer,
    private val scheduler: TransportScheduler,
    private val cursorStore: ResumeCursorStore,
    private val credentialStore: SessionCredentialStore,
    private val observer: ScopedProtocolObserver,
    private val maxPendingRequests: Int = 128,
    private val requestTimeoutMs: Long = 30_000,
) : ConnectionFleetCoordinatorFactory {
    override fun create(
        connectionId: String,
        generation: Long,
        onEvent: (ConnectionRuntimeEvent) -> Unit,
    ): ConnectionFleetCoordinator = AuthenticatedFleetCoordinator(
        fleetConnectionId = connectionId,
        fleetGeneration = generation,
        dialer = dialer,
        scheduler = scheduler,
        cursorStore = cursorStore,
        credentialStore = credentialStore,
        observer = observer,
        maxPendingRequests = maxPendingRequests,
        requestTimeoutMs = requestTimeoutMs,
        onEvent = onEvent,
    )
}

private class AuthenticatedFleetCoordinator(
    private val fleetConnectionId: String,
    private val fleetGeneration: Long,
    dialer: WebSocketDialer,
    scheduler: TransportScheduler,
    cursorStore: ResumeCursorStore,
    credentialStore: SessionCredentialStore,
    observer: ScopedProtocolObserver,
    maxPendingRequests: Int,
    requestTimeoutMs: Long,
    private val onEvent: (ConnectionRuntimeEvent) -> Unit,
) : ConnectionFleetCoordinator {
    @Volatile
    private var readyCapabilities: Set<String>? = null
    private val dialAttempts = AtomicInteger(0)
    private val authenticationRejectedAttempt = AtomicInteger(NO_ATTEMPT)
    @Volatile
    private var observerDeviceId: String? = null
    private val coordinator: AuthenticatedWsCoordinator
    private val rpc: RemoteRpc

    init {
        val reportingDialer = WebSocketDialer { target, callbacks ->
            val attempt = dialAttempts.incrementAndGet()
            try {
                dialer.open(target, reportingCallbacks(callbacks, attempt))
            } catch (exception: Throwable) {
                if (isCurrent(attempt) && authenticationRejectedAttempt.get() != attempt) {
                    readyCapabilities = null
                    onEvent(ConnectionRuntimeEvent.Retrying(fleetGeneration, closeCode = null, attempt = attempt))
                }
                throw exception
            }
        }
        coordinator = AuthenticatedWsCoordinator(
            dialer = reportingDialer,
            scheduler = scheduler,
            cursorStore = cursorStore,
            credentialStore = credentialStore,
            observer = object : ProtocolObserver {
                override fun onRuntimeEvent(connectionId: String, event: RuntimeEventPayload) {
                    currentObserverScope(connectionId)?.let { observer.onRuntimeEvent(it, event) }
                }

                override fun onReplayGap(
                    connectionId: String,
                    previous: app.switchboard.mobile.protocol.ResumeCursor?,
                    current: app.switchboard.mobile.protocol.ResumeCursor,
                ) {
                    currentObserverScope(connectionId)?.let { observer.onReplayGap(it, previous, current) }
                }

                override fun onProtocolError(connectionId: String, wire: String) {
                    currentObserverScope(connectionId)?.let { observer.onProtocolError(it, wire) }
                }

                override fun onUnhandledFrame(connectionId: String, frame: WsFrame) {
                    currentObserverScope(connectionId)?.let { observer.onUnhandledFrame(it, frame) }
                }

                override fun onTransportFailure(connectionId: String, error: Throwable) {
                    currentObserverScope(connectionId)?.let { observer.onTransportFailure(it, error) }
                }
            },
            maxPendingRequests = maxPendingRequests,
            requestTimeoutMs = requestTimeoutMs,
        )
        rpc = FleetLeasedRemoteRpc(coordinator, fleetGeneration)
    }

    override val endpoint: ConnectionFleetEndpoint?
        get() {
            val capabilities = readyCapabilities ?: return null
            if (coordinator.phase != ConnectionPhase.Ready) return null
            coordinator.currentScope ?: return null
            val leaseScope = rpc.scope ?: return null
            return ConnectionFleetEndpoint(leaseScope, capabilities, rpc)
        }

    override fun connect(target: WebSocketTarget) {
        require(target.connectionId == fleetConnectionId) { "Target connection does not match fleet entry" }
        observerDeviceId = target.deviceId
        readyCapabilities = null
        dialAttempts.set(0)
        authenticationRejectedAttempt.set(NO_ATTEMPT)
        coordinator.connect(target)
    }

    override fun disconnect() {
        readyCapabilities = null
        coordinator.disconnect()
    }

    override fun destroy() {
        readyCapabilities = null
        coordinator.destroy()
    }

    private fun reportingCallbacks(
        callbacks: WebSocketCallbacks,
        attempt: Int,
    ): WebSocketCallbacks = object : WebSocketCallbacks {
        override fun onOpen(connection: WebSocketConnection) {
            if (!isCurrent(attempt)) {
                connection.close()
                return
            }
            callbacks.onOpen(connection)
        }

        override fun onText(text: String) {
            if (!isCurrent(attempt)) return
            val frame = WsProtocol.decode(text)
            if (frame is WsFrame.Authed.Failure) {
                authenticationRejectedAttempt.set(attempt)
            }
            callbacks.onText(text)
            when {
                frame is WsFrame.Ready && coordinator.phase == ConnectionPhase.Ready -> {
                    readyCapabilities = frame.capabilities
                    onEvent(ConnectionRuntimeEvent.Ready(fleetGeneration))
                }
                frame is WsFrame.Authed.Failure -> {
                    readyCapabilities = null
                    onEvent(ConnectionRuntimeEvent.Stopped(fleetGeneration, authenticationRejected = true))
                }
            }
        }

        override fun onClosed(cause: DisconnectCause) {
            if (!isCurrent(attempt) || authenticationRejectedAttempt.get() == attempt) return
            callbacks.onClosed(cause)
            readyCapabilities = null
            onEvent(cause.toRuntimeEvent(attempt))
        }

        override fun onFailure(error: Throwable) {
            if (!isCurrent(attempt) || authenticationRejectedAttempt.get() == attempt) return
            callbacks.onFailure(error)
            readyCapabilities = null
            onEvent(ConnectionRuntimeEvent.Retrying(fleetGeneration, closeCode = null, attempt = attempt))
        }
    }

    private fun isCurrent(attempt: Int): Boolean = dialAttempts.get() == attempt

    private fun currentObserverScope(connectionId: String): TransportScope? {
        if (connectionId != fleetConnectionId) return null
        val deviceId = observerDeviceId ?: return null
        return TransportScope(deviceId, connectionId, fleetGeneration)
    }

    private fun DisconnectCause.toRuntimeEvent(attempt: Int): ConnectionRuntimeEvent = when (this) {
        DisconnectCause.AuthenticationRejected ->
            ConnectionRuntimeEvent.Stopped(fleetGeneration, authenticationRejected = true)
        DisconnectCause.Network,
        DisconnectCause.Server,
        -> ConnectionRuntimeEvent.Retrying(fleetGeneration, closeCode = null, attempt = attempt)
        DisconnectCause.UserRequested,
        DisconnectCause.ServiceDestroyed,
        -> ConnectionRuntimeEvent.Disconnected(fleetGeneration)
    }

    private companion object {
        const val NO_ATTEMPT = -1
    }
}

private class FleetLeasedRemoteRpc(
    private val coordinator: AuthenticatedWsCoordinator,
    private val leaseGeneration: Long,
) : RemoteRpc {
    override val scope: TransportScope?
        get() = coordinator.currentScope?.toLease()

    override fun invoke(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        val internal = coordinator.currentScope
        if (internal == null || expectedScope != internal.toLease()) {
            callback(RpcOutcome.Failure(RpcFailure.ConnectionReplaced))
            return RequestSubmission.Rejected(RpcFailure.ConnectionReplaced)
        }
        return coordinator.invoke(internal, channel, args, callback)
    }

    override fun onRuntimeEvent(
        listener: (TransportScope, RuntimeEventPayload) -> Unit,
    ): Cancelable {
        val capturedInternal = coordinator.currentScope ?: return Cancelable {}
        return coordinator.onRuntimeEvent { eventScope, event ->
            if (eventScope == capturedInternal && coordinator.currentScope == capturedInternal) {
                listener(capturedInternal.toLease(), event)
            }
        }
    }

    private fun TransportScope.toLease() = TransportScope(
        deviceId = deviceId,
        connectionId = connectionId,
        generation = leaseGeneration,
    )
}
