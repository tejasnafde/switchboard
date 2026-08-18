package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.ResumeCursor
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.protocol.WsFrame
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

data class WebSocketTarget(
    val deviceId: String,
    val connectionId: String,
    val url: String,
    val credential: Credential,
    val credentialRef: String? = null,
) {
    override fun toString(): String =
        "WebSocketTarget(deviceId=$deviceId, connectionId=$connectionId, url=${url.withoutQueryOrFragment()}, credential=${credential::class.simpleName})"
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

interface WebSocketConnection {
    fun send(text: String): Boolean

    fun close()
}

interface WebSocketCallbacks {
    fun onOpen(connection: WebSocketConnection)

    fun onText(text: String)

    fun onClosed(cause: DisconnectCause)

    fun onFailure(error: Throwable)
}

fun interface WebSocketDialer {
    fun open(target: WebSocketTarget, callbacks: WebSocketCallbacks): WebSocketConnection
}

fun interface Cancelable {
    fun cancel()
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
