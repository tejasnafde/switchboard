package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.ConnectionEffect
import app.switchboard.mobile.protocol.ConnectionEvent
import app.switchboard.mobile.protocol.ConnectionGeneration
import app.switchboard.mobile.protocol.ConnectionPhase
import app.switchboard.mobile.protocol.ConnectionState
import app.switchboard.mobile.protocol.ConnectionStateMachine
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RetryDecision
import app.switchboard.mobile.protocol.RetryPolicy
import app.switchboard.mobile.protocol.WsFrame
import app.switchboard.mobile.protocol.WsProtocol

sealed interface RpcFailure {
    data object NotReady : RpcFailure

    data object CapacityExceeded : RpcFailure

    data object Timeout : RpcFailure

    data object SendFailed : RpcFailure

    data object ConnectionReplaced : RpcFailure

    data class Remote(val error: String) : RpcFailure

    data class ConnectionLost(val cause: DisconnectCause) : RpcFailure

    data object ServiceDestroyed : RpcFailure
}

sealed interface RpcOutcome {
    data class Success(val result: JsonValue?) : RpcOutcome

    data class Failure(val reason: RpcFailure) : RpcOutcome
}

sealed interface RequestSubmission {
    data class Accepted(
        val requestId: Long,
        val scope: TransportScope,
    ) : RequestSubmission

    data class Rejected(val reason: RpcFailure) : RequestSubmission
}

class AuthenticatedWsCoordinator(
    private val dialer: LineDialer,
    private val scheduler: TransportScheduler,
    private val cursorStore: ResumeCursorStore,
    private val credentialStore: SessionCredentialStore,
    private val observer: ProtocolObserver,
    private val maxPendingRequests: Int = 128,
    private val requestTimeoutMs: Long = 30_000,
    private val handshakeTimeoutMs: Long = DEFAULT_HANDSHAKE_TIMEOUT_MS,
) {
    private data class PendingRequest(
        val generation: ConnectionGeneration,
        val callback: (RpcOutcome) -> Unit,
        var timeout: Cancelable? = null,
    )

    private var state: ConnectionState? = null
    private var target: LineTarget? = null
    private var socket: LineConnection? = null
    private var retryTask: Cancelable? = null
    private var probeTask: Cancelable? = null
    private var handshakeTask: Cancelable? = null
    private var retryAttempts = 0
    private var networkAvailable = true
    private var redialPending = false
    private var nextRequestId = 1L
    private var destroyed = false
    private val pending = linkedMapOf<Long, PendingRequest>()
    private val deferred = ThreadLocal<ArrayDeque<() -> Unit>>()
    private val draining = ThreadLocal<Boolean>()
    private val runtimeEventListeners =
        linkedSetOf<(TransportScope, app.switchboard.mobile.protocol.RuntimeEventPayload) -> Unit>()
    private val channelEventListeners =
        linkedMapOf<String, LinkedHashSet<(TransportScope, JsonArray) -> Unit>>()

    val phase: ConnectionPhase
        @Synchronized get() = state?.phase ?: ConnectionPhase.Disconnected

    val isApplicationSendAllowed: Boolean
        @Synchronized get() = !destroyed && state?.outboxEligible == true

    val pendingRequestCount: Int
        @Synchronized get() = pending.size

    val currentScope: TransportScope?
        @Synchronized get() = state?.generation?.let {
            TransportScope(it.deviceId, it.connectionId, it.value)
        }

    init {
        require(maxPendingRequests > 0) { "maxPendingRequests must be positive" }
        require(requestTimeoutMs > 0) { "requestTimeoutMs must be positive" }
        require(handshakeTimeoutMs > 0) { "handshakeTimeoutMs must be positive" }
    }

    fun connect(newTarget: LineTarget) {
        connectLocked(newTarget)
        drainDeferred()
    }

    @Synchronized
    private fun connectLocked(newTarget: LineTarget) {
        if (destroyed) return
        cancelRetry()
        cancelProbe()
        cancelHandshake()
        redialPending = false
        retryAttempts = 0
        drainPending(RpcFailure.ConnectionReplaced)

        val previousSocket = socket
        socket = null
        val cursor = cursorStore.load(newTarget.connectionId)
        state = state?.let {
            ConnectionStateMachine.reduce(
                it,
                ConnectionEvent.SelectConnection(
                    newTarget.deviceId,
                    newTarget.connectionId,
                    cursor,
                ),
            ).state
        } ?: ConnectionState.selected(
            deviceId = newTarget.deviceId,
            connectionId = newTarget.connectionId,
            resumeCursor = cursor,
        )
        target = newTarget
        previousSocket?.close()
        if (networkAvailable) {
            dialCurrentGeneration()
        } else {
            redialPending = true
        }
    }

    fun setNetworkAvailable(available: Boolean) {
        setNetworkAvailableLocked(available)
        drainDeferred()
    }

    @Synchronized
    private fun setNetworkAvailableLocked(available: Boolean) {
        if (destroyed || networkAvailable == available) return
        networkAvailable = available
        if (!available) {
            cancelRetry()
            val currentState = state
            val previousSocket = socket
            if (
                currentState != null &&
                (previousSocket != null || currentState.phase != ConnectionPhase.Disconnected)
            ) {
                cancelProbe()
                cancelHandshake()
                socket = null
                drainPending(RpcFailure.ConnectionLost(DisconnectCause.Network))
                applyTransition(
                    ConnectionStateMachine.reduce(
                        currentState,
                        ConnectionEvent.SocketClosed(
                            currentState.generation,
                            DisconnectCause.Network,
                        ),
                    ),
                    DisconnectCause.Network,
                )
                previousSocket?.close()
            }
            return
        }
        if (!redialPending || target == null || state?.phase != ConnectionPhase.Disconnected) return
        redialPending = false
        retryAttempts = 0
        dialCurrentGeneration()
    }

    fun probe(timeoutMs: Long = DEFAULT_PROBE_TIMEOUT_MS) {
        probeLocked(timeoutMs)
        drainDeferred()
    }

    @Synchronized
    private fun probeLocked(timeoutMs: Long) {
        if (destroyed || timeoutMs <= 0) return
        val generation = state?.generation ?: return
        val connection = socket ?: return
        if (state?.phase != ConnectionPhase.Ready) return
        cancelProbe()
        if (!connection.send(WsProtocol.encode(WsFrame.Ping(System.currentTimeMillis())))) {
            reconnectAfterFailedProbe(generation, connection)
            return
        }
        probeTask = scheduler.schedule(timeoutMs) {
            synchronized(this) {
                probeTask = null
                if (
                    !destroyed &&
                    state?.generation == generation &&
                    state?.phase == ConnectionPhase.Ready &&
                    socket === connection
                ) {
                    reconnectAfterFailedProbe(generation, connection)
                }
            }
            drainDeferred()
        }
    }

    fun invoke(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        val result = invokeLocked(expectedScope, channel, args, callback)
        drainDeferred()
        return result
    }

    @Synchronized
    private fun invokeLocked(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        if (currentScope != expectedScope) {
            defer { callback(RpcOutcome.Failure(RpcFailure.ConnectionReplaced)) }
            return RequestSubmission.Rejected(RpcFailure.ConnectionReplaced)
        }
        return invokeLocked(channel, args, callback)
    }

    fun invoke(
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        val result = invokeLocked(channel, args, callback)
        drainDeferred()
        return result
    }

    @Synchronized
    private fun invokeLocked(
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        val currentState = state
        if (destroyed || currentState?.outboxEligible != true) {
            defer { callback(RpcOutcome.Failure(RpcFailure.NotReady)) }
            return RequestSubmission.Rejected(RpcFailure.NotReady)
        }
        if (pending.size >= maxPendingRequests) {
            defer { callback(RpcOutcome.Failure(RpcFailure.CapacityExceeded)) }
            return RequestSubmission.Rejected(RpcFailure.CapacityExceeded)
        }

        val requestId = nextRequestId++
        val pendingRequest = PendingRequest(currentState.generation, callback)
        pending[requestId] = pendingRequest
        pendingRequest.timeout = scheduler.schedule(requestTimeoutMs) {
            timeout(requestId, currentState.generation)
        }
        val transition = ConnectionStateMachine.reduce(
            currentState,
            ConnectionEvent.SendRequest(
                currentState.generation,
                WsFrame.Request(requestId, channel, args),
            ),
        )
        val sent = applyTransition(transition)
        if (!sent) {
            failPending(requestId, RpcFailure.SendFailed)
            return RequestSubmission.Rejected(RpcFailure.SendFailed)
        }
        return RequestSubmission.Accepted(
            requestId,
            TransportScope(
                currentState.generation.deviceId,
                currentState.generation.connectionId,
                currentState.generation.value,
            ),
        )
    }

    @Synchronized
    fun onRuntimeEvent(
        listener: (TransportScope, app.switchboard.mobile.protocol.RuntimeEventPayload) -> Unit,
    ): Cancelable {
        runtimeEventListeners += listener
        return Cancelable {
            synchronized(this) {
                runtimeEventListeners -= listener
            }
        }
    }

    @Synchronized
    fun onChannelEvent(
        channel: String,
        listener: (TransportScope, JsonArray) -> Unit,
    ): Cancelable {
        channelEventListeners.getOrPut(channel, ::linkedSetOf) += listener
        return Cancelable {
            synchronized(this) {
                channelEventListeners[channel]?.let { listeners ->
                    listeners -= listener
                    if (listeners.isEmpty()) channelEventListeners.remove(channel)
                }
            }
        }
    }

    fun disconnect() {
        disconnectLocked()
        drainDeferred()
    }

    @Synchronized
    private fun disconnectLocked() {
        if (destroyed) return
        cancelRetry()
        cancelProbe()
        cancelHandshake()
        redialPending = false
        val currentState = state
        val previousSocket = socket
        socket = null
        drainPending(RpcFailure.ConnectionLost(DisconnectCause.UserRequested))
        if (currentState != null) {
            applyTransition(
                ConnectionStateMachine.reduce(
                    currentState,
                    ConnectionEvent.SocketClosed(
                        currentState.generation,
                        DisconnectCause.UserRequested,
                    ),
                ),
                DisconnectCause.UserRequested,
            )
        }
        previousSocket?.close()
    }

    fun destroy() {
        destroyLocked()
        drainDeferred()
    }

    @Synchronized
    private fun destroyLocked() {
        if (destroyed) return
        destroyed = true
        cancelRetry()
        cancelProbe()
        cancelHandshake()
        redialPending = false
        val previousSocket = socket
        socket = null
        drainPending(RpcFailure.ServiceDestroyed)
        state = state?.let {
            ConnectionStateMachine.reduce(it, ConnectionEvent.ServiceDestroyed).state
        }
        runtimeEventListeners.clear()
        channelEventListeners.clear()
        target = null
        previousSocket?.close()
    }

    private fun dialCurrentGeneration() {
        val currentTarget = target ?: return
        val generation = state?.generation ?: return
        val callbacks = callbacksFor(generation)
        val opened = try {
            dialer.open(currentTarget, callbacks)
        } catch (error: Throwable) {
            callbacks.onFailure(error)
            return
        }
        if (state?.generation == generation && !destroyed) {
            socket = opened
        } else {
            opened.close()
        }
    }

    private fun callbacksFor(generation: ConnectionGeneration): LineCallbacks =
        object : LineCallbacks {
            override fun onOpen(connection: LineConnection) {
                opened(generation, connection)
            }

            override fun onText(text: String) {
                received(generation, text)
            }

            override fun onClosed(cause: DisconnectCause) {
                closed(generation, cause)
            }

            override fun onFailure(error: Throwable) {
                failed(generation, error)
            }
        }

    private fun opened(
        generation: ConnectionGeneration,
        connection: LineConnection,
    ) {
        openedLocked(generation, connection)
        drainDeferred()
    }

    @Synchronized
    private fun openedLocked(
        generation: ConnectionGeneration,
        connection: LineConnection,
    ) {
        val currentState = state
        if (destroyed || currentState?.generation != generation) {
            connection.close()
            return
        }
        socket = connection
        applyTransition(
            ConnectionStateMachine.reduce(
                currentState,
                ConnectionEvent.SocketOpened(generation, target?.credential ?: return),
            ),
        )
        if (state?.generation == generation && state?.phase != ConnectionPhase.Ready) {
            armHandshakeTimeout(generation, connection)
        }
    }

    private fun received(
        generation: ConnectionGeneration,
        wire: String,
    ) {
        receivedLocked(generation, wire)
        drainDeferred()
    }

    @Synchronized
    private fun receivedLocked(
        generation: ConnectionGeneration,
        wire: String,
    ) {
        val currentState = state ?: return
        if (destroyed || currentState.generation != generation) return
        cancelProbe()
        val frame = WsProtocol.decode(wire)
        if (frame == null) {
            val connectionId = currentState.generation.connectionId
            defer { observer.onProtocolError(connectionId, wire) }
            return
        }
        val wasReady = currentState.outboxEligible
        val authenticationRejected = frame is WsFrame.Authed.Failure
        applyTransition(
            ConnectionStateMachine.reduce(
                currentState,
                ConnectionEvent.FrameReceived(generation, frame),
            ),
        )
        if (state?.phase == ConnectionPhase.Ready || state?.phase == ConnectionPhase.Disconnected) {
            cancelHandshake()
        }
        if (authenticationRejected) {
            val rejectedSocket = socket
            socket = null
            rejectedSocket?.close()
        }
        if (!wasReady && state?.outboxEligible == true) {
            retryAttempts = 0
            redialPending = false
            cancelRetry()
        }
    }

    private fun closed(
        generation: ConnectionGeneration,
        cause: DisconnectCause,
    ) {
        closedLocked(generation, cause)
        drainDeferred()
    }

    @Synchronized
    private fun closedLocked(
        generation: ConnectionGeneration,
        cause: DisconnectCause,
    ) {
        val currentState = state ?: return
        if (destroyed || currentState.generation != generation) return
        cancelProbe()
        cancelHandshake()
        socket = null
        drainPending(RpcFailure.ConnectionLost(cause))
        applyTransition(
            ConnectionStateMachine.reduce(
                currentState,
                ConnectionEvent.SocketClosed(generation, cause),
            ),
            cause,
        )
    }

    private fun failed(
        generation: ConnectionGeneration,
        error: Throwable,
    ) {
        failedLocked(generation, error)
        drainDeferred()
    }

    @Synchronized
    private fun failedLocked(
        generation: ConnectionGeneration,
        error: Throwable,
    ) {
        val currentState = state ?: return
        if (destroyed || currentState.generation != generation) return
        val failedSocket = socket
        val connectionId = currentState.generation.connectionId
        defer { observer.onTransportFailure(connectionId, error) }
        val cause = if (error is NonRetryableTransportFailure) {
            DisconnectCause.UserRequested
        } else {
            DisconnectCause.Network
        }
        closed(generation, cause)
        failedSocket?.close()
    }

    private fun timeout(
        requestId: Long,
        generation: ConnectionGeneration,
    ) {
        timeoutLocked(requestId, generation)
        drainDeferred()
    }

    @Synchronized
    private fun timeoutLocked(
        requestId: Long,
        generation: ConnectionGeneration,
    ) {
        val request = pending[requestId] ?: return
        if (request.generation != generation || state?.generation != generation) return
        pending.remove(requestId)
        defer { request.callback(RpcOutcome.Failure(RpcFailure.Timeout)) }
    }

    private fun applyTransition(
        transition: app.switchboard.mobile.protocol.ConnectionTransition,
        disconnectCause: DisconnectCause? = null,
    ): Boolean {
        val previousCursor = state?.resumeCursor
        state = transition.state
        var allSendsSucceeded = true
        var credentialVerified = true
        transition.effects.forEach { effect ->
            if (!credentialVerified) return@forEach
            when (effect) {
                is ConnectionEffect.Send -> {
                    val sent = socket?.send(WsProtocol.encode(effect.frame)) == true
                    allSendsSucceeded = allSendsSucceeded && sent
                }
                is ConnectionEffect.PersistSession -> {
                    credentialVerified = persistMintedSession(effect.session)
                }
                is ConnectionEffect.DeliverResponse -> completeResponse(effect.response)
                is ConnectionEffect.DeliverRuntimeEvent -> {
                    val scope = TransportScope(
                        transition.state.generation.deviceId,
                        transition.state.generation.connectionId,
                        transition.state.generation.value,
                    )
                    val delivered = effect.event.copy(sequence = effect.sequence)
                    val connectionId = transition.state.generation.connectionId
                    defer {
                        observer.onRuntimeEvent(connectionId, delivered)
                        runtimeListeners().forEach { it(scope, delivered) }
                    }
                }
                is ConnectionEffect.ReplayGap -> {
                    val connectionId = transition.state.generation.connectionId
                    defer { observer.onReplayGap(connectionId, effect.previous, effect.current) }
                }
                is ConnectionEffect.DeliverFrame -> {
                    val connectionId = transition.state.generation.connectionId
                    val frame = effect.frame
                    val event = frame as? WsFrame.Event
                    val scope = TransportScope(
                        transition.state.generation.deviceId,
                        connectionId,
                        transition.state.generation.value,
                    )
                    defer {
                        observer.onUnhandledFrame(connectionId, frame)
                        if (event != null) channelListeners(event.channel).forEach { it(scope, event.args) }
                    }
                }
                is ConnectionEffect.ScheduleRetry -> {
                    scheduleRetry(effect.decision, disconnectCause)
                }
                is ConnectionEffect.IgnoreStale,
                is ConnectionEffect.IgnoreUnexpected,
                -> Unit
            }
        }
        if (!credentialVerified) {
            abortUnverifiedPairing()
            return false
        }
        val currentCursor = transition.state.resumeCursor
        if (
            transition.state.outboxEligible &&
            currentCursor != null &&
            currentCursor != previousCursor
        ) {
            cursorStore.save(transition.state.generation.connectionId, currentCursor)
        }
        return allSendsSucceeded
    }

    private fun persistMintedSession(session: String): Boolean {
        val currentTarget = target ?: return false
        val verified = try {
            credentialStore.saveAndVerifySession(
                currentTarget.connectionId,
                currentTarget.credentialRef,
                session,
            )
        } catch (_: Throwable) {
            false
        }
        if (!verified) return false
        target = currentTarget.copy(credential = Credential.Session(session))
        if (currentTarget.credential is Credential.Pairing) {
            credentialStore.retireLegacyCredentials(currentTarget.connectionId)
        }
        return true
    }

    private fun abortUnverifiedPairing() {
        val currentState = state ?: return
        val previousSocket = socket
        socket = null
        cancelRetry()
        state = ConnectionStateMachine.reduce(
            currentState,
            ConnectionEvent.SocketClosed(
                currentState.generation,
                DisconnectCause.AuthenticationRejected,
            ),
        ).state
        previousSocket?.close()
    }

    private fun completeResponse(response: WsFrame.Response) {
        val request = pending.remove(response.id) ?: return
        request.timeout?.cancel()
        val outcome = when (response) {
            is WsFrame.Response.Success -> RpcOutcome.Success(response.result)
            is WsFrame.Response.Failure -> RpcOutcome.Failure(RpcFailure.Remote(response.error))
        }
        defer { request.callback(outcome) }
    }

    private fun scheduleRetry(
        reducerDecision: RetryDecision,
        disconnectCause: DisconnectCause?,
    ) {
        cancelRetry()
        if (reducerDecision is RetryDecision.Stop || disconnectCause == null) {
            redialPending = false
            return
        }
        val decision = RetryPolicy.decide(disconnectCause, retryAttempts)
        if (decision !is RetryDecision.After) {
            redialPending = false
            return
        }
        redialPending = true
        if (!networkAvailable) return
        retryAttempts++
        val generation = state?.generation ?: return
        retryTask = scheduler.schedule(decision.delayMs) {
            synchronized(this) {
                retryTask = null
                if (
                    !destroyed &&
                    networkAvailable &&
                    redialPending &&
                    state?.generation == generation
                ) {
                    redialPending = false
                    dialCurrentGeneration()
                }
            }
            drainDeferred()
        }
    }

    private fun cancelRetry() {
        retryTask?.cancel()
        retryTask = null
    }

    private fun cancelProbe() {
        probeTask?.cancel()
        probeTask = null
    }

    private fun armHandshakeTimeout(
        generation: ConnectionGeneration,
        connection: LineConnection,
    ) {
        cancelHandshake()
        handshakeTask = scheduler.schedule(handshakeTimeoutMs) {
            synchronized(this) {
                handshakeTask = null
                val currentState = state ?: return@synchronized
                if (
                    destroyed ||
                    currentState.generation != generation ||
                    currentState.phase == ConnectionPhase.Ready ||
                    socket !== connection
                ) {
                    return@synchronized
                }
                socket = null
                val connectionId = currentState.generation.connectionId
                defer { observer.onTransportFailure(connectionId, HandshakeTimeoutFailure()) }
                applyTransition(
                    ConnectionStateMachine.reduce(
                        currentState,
                        ConnectionEvent.SocketClosed(
                            generation,
                            DisconnectCause.UserRequested,
                        ),
                    ),
                    DisconnectCause.UserRequested,
                )
                connection.close()
            }
            drainDeferred()
        }
    }

    private fun cancelHandshake() {
        handshakeTask?.cancel()
        handshakeTask = null
    }

    private fun reconnectAfterFailedProbe(
        generation: ConnectionGeneration,
        connection: LineConnection,
    ) {
        if (destroyed || state?.generation != generation || socket !== connection) return
        socket = null
        closed(generation, DisconnectCause.Network)
        connection.close()
    }

    private fun failPending(
        requestId: Long,
        failure: RpcFailure,
    ) {
        val request = pending.remove(requestId) ?: return
        request.timeout?.cancel()
        defer { request.callback(RpcOutcome.Failure(failure)) }
    }

    private fun drainPending(failure: RpcFailure) {
        val requests = pending.values.toList()
        pending.clear()
        requests.forEach { request ->
            request.timeout?.cancel()
            defer { request.callback(RpcOutcome.Failure(failure)) }
        }
    }

    /**
     * Read when the delivery runs, not when it was queued. A listener cancelled
     * between the two, or retired by destroy(), must not still be called: its
     * owner may already have torn down the state the callback writes to.
     */
    private fun runtimeListeners():
        List<(TransportScope, app.switchboard.mobile.protocol.RuntimeEventPayload) -> Unit> =
        synchronized(this) { runtimeEventListeners.toList() }

    private fun channelListeners(channel: String): List<(TransportScope, JsonArray) -> Unit> =
        synchronized(this) { channelEventListeners[channel]?.toList().orEmpty() }

    private fun defer(block: () -> Unit) {
        val queue = deferred.get() ?: ArrayDeque<() -> Unit>().also(deferred::set)
        queue.addLast(block)
    }

    /**
     * Runs this thread's queued callbacks and listener deliveries unlocked.
     * Invoking app code under this monitor deadlocks against threads that take
     * a session coordinator's lock first. Thread-local queues keep each thread's
     * deliveries in order and stop one thread running another's callbacks while
     * it holds unrelated locks.
     */
    private fun drainDeferred() {
        if (Thread.holdsLock(this) || draining.get() == true) return
        val queue = deferred.get() ?: return
        if (queue.isEmpty()) return
        draining.set(true)
        var thrown: Throwable? = null
        try {
            while (true) {
                val next = queue.removeFirstOrNull() ?: break
                try {
                    next()
                } catch (t: Throwable) {
                    if (thrown == null) thrown = t else thrown.addSuppressed(t)
                }
            }
        } finally {
            draining.set(false)
        }
        thrown?.let { throw it }
    }

    private companion object {
        const val DEFAULT_PROBE_TIMEOUT_MS = 3_000L
        const val DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000L
    }
}

internal class HandshakeTimeoutFailure : RuntimeException("backend handshake timed out"),
    NonRetryableTransportFailure {
    override val reason = app.switchboard.mobile.domain.connection.ConnectionTerminalReason.BackendHandshakeTimedOut
}
