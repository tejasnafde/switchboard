package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import java.io.Closeable
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter

enum class ProtocolHubEventCategory {
    Runtime,
    ReplayGap,
    ProtocolError,
    TransportFailure,
}

sealed interface ProtocolHubEvent {
    val scope: TransportScope
    val connectionId: String
        get() = scope.connectionId
    val category: ProtocolHubEventCategory

    data class Runtime(
        override val scope: TransportScope,
        val event: RuntimeEventPayload,
    ) : ProtocolHubEvent {
        override val category = ProtocolHubEventCategory.Runtime
    }

    data class ReplayGap(
        override val scope: TransportScope,
        val previous: ResumeCursor?,
        val current: ResumeCursor,
    ) : ProtocolHubEvent {
        override val category = ProtocolHubEventCategory.ReplayGap
    }

    data class ProtocolError(
        override val scope: TransportScope,
    ) : ProtocolHubEvent {
        override val category = ProtocolHubEventCategory.ProtocolError
    }

    data class TransportFailure(
        override val scope: TransportScope,
    ) : ProtocolHubEvent {
        override val category = ProtocolHubEventCategory.TransportFailure
    }
}

data class ProtocolEventHubHealth(
    val droppedEventCount: Long = 0,
    val lastOverflowConnectionId: String? = null,
    val lastOverflowCategory: ProtocolHubEventCategory? = null,
    val lastErrorConnectionId: String? = null,
    val lastErrorCategory: ProtocolHubEventCategory? = null,
    val closed: Boolean = false,
)

class ProtocolEventHub(
    bufferCapacity: Int,
) : ScopedProtocolObserver, Closeable {
    private val mutableEvents = MutableSharedFlow<ProtocolHubEvent>(
        replay = 0,
        extraBufferCapacity = bufferCapacity,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )
    val events = mutableEvents.asSharedFlow()

    private val mutableHealth = MutableStateFlow(ProtocolEventHubHealth())
    val health = mutableHealth.asStateFlow()

    private var closed = false

    init {
        require(bufferCapacity > 0) { "bufferCapacity must be positive" }
    }

    fun eventsFor(connectionId: String): Flow<ProtocolHubEvent> =
        events.filter { it.connectionId == connectionId }

    fun eventsFor(scope: TransportScope): Flow<ProtocolHubEvent> =
        events.filter { it.scope == scope }

    override fun onRuntimeEvent(scope: TransportScope, event: RuntimeEventPayload) {
        publish(ProtocolHubEvent.Runtime(scope, event))
    }

    override fun onReplayGap(
        scope: TransportScope,
        previous: ResumeCursor?,
        current: ResumeCursor,
    ) {
        publish(ProtocolHubEvent.ReplayGap(scope, previous, current))
    }

    @Suppress("UNUSED_PARAMETER")
    override fun onProtocolError(scope: TransportScope, wire: String) {
        publish(ProtocolHubEvent.ProtocolError(scope))
    }

    @Suppress("UNUSED_PARAMETER")
    override fun onTransportFailure(scope: TransportScope, error: Throwable) {
        publish(ProtocolHubEvent.TransportFailure(scope))
    }

    override fun onUnhandledFrame(scope: TransportScope, frame: WsFrame) = Unit

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        mutableHealth.value = mutableHealth.value.copy(closed = true)
    }

    @Synchronized
    private fun publish(event: ProtocolHubEvent) {
        if (closed) return
        if (
            event.category == ProtocolHubEventCategory.ProtocolError ||
            event.category == ProtocolHubEventCategory.TransportFailure
        ) {
            mutableHealth.value = mutableHealth.value.copy(
                lastErrorConnectionId = event.connectionId,
                lastErrorCategory = event.category,
            )
        }
        if (!mutableEvents.tryEmit(event)) {
            val current = mutableHealth.value
            mutableHealth.value = current.copy(
                droppedEventCount = current.droppedEventCount + 1,
                lastOverflowConnectionId = event.connectionId,
                lastOverflowCategory = event.category,
            )
        }
    }
}
