package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import app.switchboard.mobile.domain.connection.ConnectionTerminalReason
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

sealed interface LineEndpoint {
    data class DirectWebSocket(val url: String) : LineEndpoint

    data class CloudIap(val target: IapTarget) : LineEndpoint
}

data class LineTarget(
    val deviceId: String,
    val connectionId: String,
    val endpoint: LineEndpoint,
    val credential: Credential,
    val credentialRef: String? = null,
) {
    constructor(
        deviceId: String,
        connectionId: String,
        url: String,
        credential: Credential,
        credentialRef: String? = null,
    ) : this(
        deviceId = deviceId,
        connectionId = connectionId,
        endpoint = LineEndpoint.DirectWebSocket(url),
        credential = credential,
        credentialRef = credentialRef,
    )

    /** Compatibility accessor for direct-WebSocket callers. */
    val url: String
        get() = (endpoint as? LineEndpoint.DirectWebSocket)?.url
            ?: error("Cloud IAP targets do not have a backend WebSocket URL")

    override fun toString(): String =
        "LineTarget(deviceId=$deviceId, connectionId=$connectionId, endpoint=${endpoint.redacted()}, credential=${credential::class.simpleName})"
}

typealias WebSocketTarget = LineTarget

private fun LineEndpoint.redacted(): String = when (this) {
    is LineEndpoint.DirectWebSocket -> "DirectWebSocket(url=${url.withoutQueryOrFragment()})"
    is LineEndpoint.CloudIap -> "CloudIap(target=$target)"
}

private fun String.withoutQueryOrFragment(): String {
    val query = indexOf('?').takeIf { it >= 0 } ?: length
    val fragment = indexOf('#').takeIf { it >= 0 } ?: length
    return substring(0, minOf(query, fragment))
}

data class TransportScope(
    val deviceId: String,
    val connectionId: String,
    val generation: Long,
)

interface LineConnection {
    fun send(text: String): Boolean

    fun close()
}

interface LineCallbacks {
    fun onOpen(connection: LineConnection)

    fun onText(text: String)

    fun onClosed(cause: DisconnectCause)

    fun onFailure(error: Throwable)
}

fun interface LineDialer {
    fun open(target: LineTarget, callbacks: LineCallbacks): LineConnection
}

typealias WebSocketConnection = LineConnection
typealias WebSocketCallbacks = LineCallbacks
typealias WebSocketDialer = LineDialer

fun interface Cancelable {
    fun cancel()
}

/** A transport prerequisite that cannot recover through background redial alone. */
interface NonRetryableTransportFailure {
    val reason: ConnectionTerminalReason
}

fun interface TransportScheduler {
    fun schedule(delayMs: Long, block: () -> Unit): Cancelable
}

class ExecutorTransportScheduler(
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(),
) : TransportScheduler, AutoCloseable {
    override fun schedule(delayMs: Long, block: () -> Unit): Cancelable {
        val future = executor.schedule(block, delayMs, TimeUnit.MILLISECONDS)
        return Cancelable { future.cancel(false) }
    }

    override fun close() {
        executor.shutdownNow()
    }
}

interface ResumeCursorStore {
    fun load(connectionId: String): ResumeCursor?

    fun save(connectionId: String, cursor: ResumeCursor)
}

interface SessionCredentialStore {
    /**
     * Writes the minted device session and verifies a read-back before
     * returning. False means the pairing credential must remain available.
     */
    fun saveAndVerifySession(
        connectionId: String,
        expectedOldRef: String?,
        session: String,
    ): Boolean

    fun retireLegacyCredentials(connectionId: String)
}

interface ProtocolObserver {
    fun onRuntimeEvent(connectionId: String, event: RuntimeEventPayload)

    fun onReplayGap(
        connectionId: String,
        previous: ResumeCursor?,
        current: ResumeCursor,
    )

    fun onProtocolError(connectionId: String, wire: String)

    fun onUnhandledFrame(connectionId: String, frame: WsFrame) = Unit

    fun onTransportFailure(connectionId: String, error: Throwable) = Unit
}

/** Fleet-facing observer whose events retain the exact lease generation. */
interface ScopedProtocolObserver {
    fun onRuntimeEvent(scope: TransportScope, event: RuntimeEventPayload)

    fun onReplayGap(
        scope: TransportScope,
        previous: ResumeCursor?,
        current: ResumeCursor,
    )

    fun onProtocolError(scope: TransportScope, wire: String)

    fun onUnhandledFrame(scope: TransportScope, frame: WsFrame) = Unit

    fun onTransportFailure(scope: TransportScope, error: Throwable) = Unit
}
