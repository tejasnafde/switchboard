package app.switchboard.mobile.protocol

data class ConnectionGeneration(
    val deviceId: String,
    val connectionId: String,
    val value: Long,
) {
    fun next(
        deviceId: String = this.deviceId,
        connectionId: String = this.connectionId,
    ): ConnectionGeneration = ConnectionGeneration(deviceId, connectionId, value + 1)
}

enum class ConnectionPhase {
    Disconnected,
    Authenticating,
    AwaitingReady,
    Ready,
}

data class ConnectionState(
    val generation: ConnectionGeneration,
    val phase: ConnectionPhase,
    val resumeCursor: ResumeCursor?,
    val pendingRequestIds: Set<Long>,
    val heldReplayEvents: List<WsFrame.Event> = emptyList(),
    val capabilities: Set<String> = emptySet(),
) {
    val outboxEligible: Boolean
        get() = phase == ConnectionPhase.Ready

    fun supports(capability: String): Boolean = capability in capabilities

    companion object {
        fun selected(
            deviceId: String,
            connectionId: String,
            resumeCursor: ResumeCursor?,
        ): ConnectionState = ConnectionState(
            generation = ConnectionGeneration(deviceId, connectionId, 1),
            phase = ConnectionPhase.Disconnected,
            resumeCursor = resumeCursor,
            pendingRequestIds = emptySet(),
            heldReplayEvents = emptyList(),
            capabilities = emptySet(),
        )
    }
}

sealed interface Credential {
    data class Session(val token: String) : Credential {
        override fun toString(): String = "Session(token=[REDACTED])"
    }

    data class Pairing(
        val code: String,
        val deviceLabel: String,
    ) : Credential {
        override fun toString(): String = "Pairing(code=[REDACTED], deviceLabel=$deviceLabel)"
    }

    data class LegacySharedToken(val token: String) : Credential {
        override fun toString(): String = "LegacySharedToken(token=[REDACTED])"
    }
}

enum class DisconnectCause {
    Network,
    Server,
    AuthenticationRejected,
    UserRequested,
    ServiceDestroyed,
}

sealed interface RetryDecision {
    data class After(val delayMs: Long) : RetryDecision

    data object Stop : RetryDecision
}

object RetryPolicy {
    fun decide(cause: DisconnectCause, attempts: Int): RetryDecision =
        when (cause) {
            DisconnectCause.Network,
            DisconnectCause.Server,
            -> {
                val exponent = attempts.coerceIn(0, 4)
                RetryDecision.After((1_000L shl exponent).coerceAtMost(16_000L))
            }
            DisconnectCause.AuthenticationRejected,
            DisconnectCause.UserRequested,
            DisconnectCause.ServiceDestroyed,
            -> RetryDecision.Stop
        }
}

sealed interface ConnectionEvent {
    data class SelectConnection(
        val deviceId: String,
        val connectionId: String,
        val resumeCursor: ResumeCursor?,
    ) : ConnectionEvent

    data class SocketOpened(
        val generation: ConnectionGeneration,
        val credential: Credential,
    ) : ConnectionEvent

    data class FrameReceived(
        val generation: ConnectionGeneration,
        val frame: WsFrame,
    ) : ConnectionEvent

    data class SendRequest(
        val generation: ConnectionGeneration,
        val request: WsFrame.Request,
    ) : ConnectionEvent

    data class SocketClosed(
        val generation: ConnectionGeneration,
        val cause: DisconnectCause,
    ) : ConnectionEvent

    data object ServiceDestroyed : ConnectionEvent
}

sealed interface ConnectionEffect {
    data class Send(val frame: WsFrame) : ConnectionEffect

    data class PersistSession(val session: String) : ConnectionEffect

    data class DeliverResponse(val response: WsFrame.Response) : ConnectionEffect

    data class DeliverRuntimeEvent(
        val event: RuntimeEventPayload,
        val sequence: Long?,
    ) : ConnectionEffect

    data class DeliverFrame(val frame: WsFrame) : ConnectionEffect

    data class ReplayGap(
        val previous: ResumeCursor?,
        val current: ResumeCursor,
    ) : ConnectionEffect

    data class ScheduleRetry(val decision: RetryDecision) : ConnectionEffect

    data class IgnoreStale(
        val expected: ConnectionGeneration,
        val received: ConnectionGeneration,
    ) : ConnectionEffect

    data class IgnoreUnexpected(val reason: String) : ConnectionEffect
}

data class ConnectionTransition(
    val state: ConnectionState,
    val effects: List<ConnectionEffect> = emptyList(),
)

object ConnectionStateMachine {
    fun reduce(state: ConnectionState, event: ConnectionEvent): ConnectionTransition =
        when (event) {
            is ConnectionEvent.SelectConnection -> ConnectionTransition(
                state.copy(
                    generation = state.generation.next(event.deviceId, event.connectionId),
                    phase = ConnectionPhase.Disconnected,
                    resumeCursor = event.resumeCursor,
                    pendingRequestIds = emptySet(),
                    heldReplayEvents = emptyList(),
                    capabilities = emptySet(),
                ),
            )
            is ConnectionEvent.SocketOpened -> {
                if (event.generation != state.generation) return stale(state, event.generation)
                if (state.phase != ConnectionPhase.Disconnected) {
                    return unexpected(state, "socket opened outside disconnected state")
                }
                when (val credential = event.credential) {
                    is Credential.LegacySharedToken -> ConnectionTransition(
                        state.copy(phase = ConnectionPhase.AwaitingReady),
                        listOf(ConnectionEffect.Send(WsFrame.Hello(state.resumeCursor))),
                    )
                    is Credential.Session -> ConnectionTransition(
                        state.copy(phase = ConnectionPhase.Authenticating),
                        listOf(ConnectionEffect.Send(WsFrame.Auth(session = credential.token))),
                    )
                    is Credential.Pairing -> ConnectionTransition(
                        state.copy(phase = ConnectionPhase.Authenticating),
                        listOf(
                            ConnectionEffect.Send(
                                WsFrame.Auth(
                                    pairing = credential.code,
                                    label = credential.deviceLabel,
                                ),
                            ),
                        ),
                    )
                }
            }
            is ConnectionEvent.FrameReceived -> receive(state, event)
            is ConnectionEvent.SendRequest -> {
                if (event.generation != state.generation) return stale(state, event.generation)
                if (!state.outboxEligible) return unexpected(state, "request before authenticated ready")
                ConnectionTransition(
                    state.copy(pendingRequestIds = state.pendingRequestIds + event.request.id),
                    listOf(ConnectionEffect.Send(event.request)),
                )
            }
            is ConnectionEvent.SocketClosed -> {
                if (event.generation != state.generation) return stale(state, event.generation)
                val decision = RetryPolicy.decide(event.cause, attempts = 0)
                ConnectionTransition(
                    state.copy(
                        generation = state.generation.next(),
                        phase = ConnectionPhase.Disconnected,
                        pendingRequestIds = emptySet(),
                        heldReplayEvents = emptyList(),
                        capabilities = emptySet(),
                    ),
                    listOf(ConnectionEffect.ScheduleRetry(decision)),
                )
            }
            ConnectionEvent.ServiceDestroyed -> ConnectionTransition(
                state.copy(
                    generation = state.generation.next(),
                    phase = ConnectionPhase.Disconnected,
                    pendingRequestIds = emptySet(),
                    heldReplayEvents = emptyList(),
                    capabilities = emptySet(),
                ),
            )
        }

    private fun receive(
        state: ConnectionState,
        event: ConnectionEvent.FrameReceived,
    ): ConnectionTransition {
        if (event.generation != state.generation) return stale(state, event.generation)
        return when (val frame = event.frame) {
            is WsFrame.Authed.Success -> {
                if (state.phase != ConnectionPhase.Authenticating) {
                    return unexpected(state, "authentication response outside handshake")
                }
                val effects = buildList {
                    frame.session?.let { add(ConnectionEffect.PersistSession(it)) }
                    add(ConnectionEffect.Send(WsFrame.Hello(state.resumeCursor)))
                }
                ConnectionTransition(
                    state.copy(phase = ConnectionPhase.AwaitingReady),
                    effects,
                )
            }
            is WsFrame.Authed.Failure -> ConnectionTransition(
                state.copy(
                    generation = state.generation.next(),
                    phase = ConnectionPhase.Disconnected,
                    pendingRequestIds = emptySet(),
                    heldReplayEvents = emptyList(),
                    capabilities = emptySet(),
                ),
                listOf(ConnectionEffect.ScheduleRetry(RetryDecision.Stop)),
            )
            is WsFrame.Ready -> {
                if (state.phase != ConnectionPhase.AwaitingReady) {
                    return unexpected(state, "ready outside authenticated handshake")
                }
                val current = ResumeCursor(frame.epoch, frame.sequence)
                val effects = if (frame.gap) {
                    listOf(ConnectionEffect.ReplayGap(state.resumeCursor, current))
                } else {
                    state.heldReplayEvents.map(::deliveryEffect)
                }
                ConnectionTransition(
                    state.copy(
                        phase = ConnectionPhase.Ready,
                        resumeCursor = current,
                        heldReplayEvents = emptyList(),
                        capabilities = frame.capabilities,
                    ),
                    effects,
                )
            }
            is WsFrame.Response -> {
                if (!state.outboxEligible || frame.id !in state.pendingRequestIds) {
                    return unexpected(state, "response is not pending on current generation")
                }
                ConnectionTransition(
                    state.copy(pendingRequestIds = state.pendingRequestIds - frame.id),
                    listOf(ConnectionEffect.DeliverResponse(frame)),
                )
            }
            is WsFrame.Event -> {
                if (state.phase == ConnectionPhase.AwaitingReady) {
                    ConnectionTransition(
                        state.copy(heldReplayEvents = state.heldReplayEvents + frame),
                    )
                } else {
                    receiveEvent(state, frame)
                }
            }
            is WsFrame.Ping -> ConnectionTransition(
                state,
                listOf(ConnectionEffect.Send(WsFrame.Pong(frame.timestamp))),
            )
            else -> ConnectionTransition(state, listOf(ConnectionEffect.DeliverFrame(frame)))
        }
    }

    private fun receiveEvent(
        state: ConnectionState,
        frame: WsFrame.Event,
    ): ConnectionTransition {
        if (!state.outboxEligible) return unexpected(state, "event before authenticated ready")
        val currentCursor = state.resumeCursor
        val updatedCursor = if (
            currentCursor?.epoch != null &&
            frame.sequence != null &&
            (currentCursor.sequence == null || frame.sequence > currentCursor.sequence)
        ) {
            currentCursor.copy(sequence = frame.sequence)
        } else {
            currentCursor
        }
        if (frame.channel != "provider:event") {
            return ConnectionTransition(
                state.copy(resumeCursor = updatedCursor),
                listOf(ConnectionEffect.DeliverFrame(frame)),
            )
        }
        val event = (frame.args.values.firstOrNull() as? JsonObject)
            ?.let(RuntimeEventPayload::parse)
            ?: return ConnectionTransition(
                state.copy(resumeCursor = updatedCursor),
                listOf(ConnectionEffect.DeliverFrame(frame)),
            )
        return ConnectionTransition(
            state.copy(resumeCursor = updatedCursor),
            listOf(ConnectionEffect.DeliverRuntimeEvent(event, frame.sequence)),
        )
    }

    private fun deliveryEffect(frame: WsFrame.Event): ConnectionEffect {
        if (frame.channel != "provider:event") return ConnectionEffect.DeliverFrame(frame)
        val event = (frame.args.values.firstOrNull() as? JsonObject)
            ?.let(RuntimeEventPayload::parse)
            ?: return ConnectionEffect.DeliverFrame(frame)
        return ConnectionEffect.DeliverRuntimeEvent(event, frame.sequence)
    }

    private fun stale(
        state: ConnectionState,
        received: ConnectionGeneration,
    ): ConnectionTransition = ConnectionTransition(
        state,
        listOf(ConnectionEffect.IgnoreStale(state.generation, received)),
    )

    private fun unexpected(
        state: ConnectionState,
        reason: String,
    ): ConnectionTransition = ConnectionTransition(
        state,
        listOf(ConnectionEffect.IgnoreUnexpected(reason)),
    )
}
