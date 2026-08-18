package app.switchboard.mobile.platform.iap

import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.domain.connection.ConnectionTerminalReason
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.LineCallbacks
import app.switchboard.mobile.platform.protocol.LineConnection
import app.switchboard.mobile.platform.protocol.LineDialer
import app.switchboard.mobile.platform.protocol.LineEndpoint
import app.switchboard.mobile.platform.protocol.LineTarget
import app.switchboard.mobile.platform.protocol.NonRetryableTransportFailure
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.charset.StandardCharsets
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

sealed interface IapAccessTokenResult {
    data class Available(val token: String) : IapAccessTokenResult {
        override fun toString(): String = "Available(token=[REDACTED])"
    }

    data object SignedOut : IapAccessTokenResult

    data object Blocked : IapAccessTokenResult

    data class RetryableFailure(val reason: String) : IapAccessTokenResult {
        override fun toString(): String = "RetryableFailure(reason=[REDACTED])"
    }
}

fun interface IapAccessTokenProvider {
    fun request(callback: (IapAccessTokenResult) -> Unit): Cancelable
}

interface IapRelaySocket {
    fun send(bytes: ByteArray): Boolean

    fun close()
}

interface IapRelaySocketCallbacks {
    fun onOpen(socket: IapRelaySocket)

    fun onBinary(socket: IapRelaySocket, bytes: ByteArray)

    fun onClosed(socket: IapRelaySocket, cause: DisconnectCause)

    fun onFailure(socket: IapRelaySocket, error: Throwable)
}

fun interface IapRelaySocketFactory {
    fun open(request: IapRelayRequest, callbacks: IapRelaySocketCallbacks): IapRelaySocket
}

data class IapRelayRequest(
    val url: String,
    private val headers: Map<String, String>,
) {
    fun header(name: String): String? = headers.entries.firstOrNull {
        it.key.equals(name, ignoreCase = true)
    }?.value

    internal fun toOkHttpRequest(): Request = Request.Builder()
        .url(url)
        .apply { headers.forEach(::header) }
        .build()

    override fun toString(): String = "IapRelayRequest(url=$url, headers=${headers.keys})"
}

object IapRelayRequestPolicy {
    fun build(target: IapTarget, accessToken: String): IapRelayRequest {
        require(accessToken.isNotBlank()) { "Cloud IAP access token is missing" }
        val query = okhttp3.HttpUrl.Builder()
            .scheme("https")
            .host(RELAY_HOST)
            .addPathSegments(RELAY_PATH)
            .addQueryParameter("project", target.project)
            .addQueryParameter("port", target.port.toString())
            .addQueryParameter("newWebsocket", "True")
            .addQueryParameter("zone", target.zone)
            .addQueryParameter("instance", target.instance)
            .addQueryParameter("interface", target.networkInterface)
            .build()
            .encodedQuery
            ?: error("Cloud IAP relay query is missing")
        return IapRelayRequest(
            url = "wss://$RELAY_HOST/$RELAY_PATH?$query",
            headers = linkedMapOf(
                "Origin" to "bot:iap-tunneler",
                "Authorization" to "Bearer $accessToken",
                "User-Agent" to "switchboard-mobile",
                "Sec-WebSocket-Protocol" to "relay.tunnel.cloudproxy.app",
            ),
        )
    }

    private const val RELAY_HOST = "tunnel.cloudproxy.app"
    private const val RELAY_PATH = "v4/connect"
}

class OkHttpIapRelaySocketFactory(
    private val client: OkHttpClient,
) : IapRelaySocketFactory {
    override fun open(request: IapRelayRequest, callbacks: IapRelaySocketCallbacks): IapRelaySocket {
        lateinit var socket: OkHttpIapRelaySocket
        val webSocket = client.newWebSocket(
            request.toOkHttpRequest(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    callbacks.onOpen(socket)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    callbacks.onBinary(socket, bytes.toByteArray())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    callbacks.onFailure(socket, IapRelayProtocolException("IAP relay sent a text frame"))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    callbacks.onClosed(socket, DisconnectCause.Server)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    callbacks.onFailure(socket, t)
                }
            },
        )
        socket = OkHttpIapRelaySocket(webSocket)
        return socket
    }

    private class OkHttpIapRelaySocket(
        private val webSocket: WebSocket,
    ) : IapRelaySocket {
        override fun send(bytes: ByteArray): Boolean = webSocket.send(ByteString.of(*bytes))

        override fun close() {
            webSocket.close(NORMAL_CLOSURE, "client lifecycle")
        }
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
    }
}

class IapRelayDialer(
    private val tokenProvider: IapAccessTokenProvider,
    private val relaySocketFactory: IapRelaySocketFactory,
    private val scheduler: TransportScheduler,
    private val connectTimeoutMs: Long = 30_000,
    private val maxQueuedLines: Int = 128,
    private val maxQueuedUtf8Bytes: Int = 512 * 1024,
) : LineDialer {
    init {
        require(connectTimeoutMs > 0)
    }

    override fun open(target: LineTarget, callbacks: LineCallbacks): LineConnection {
        val iapTarget = (target.endpoint as? LineEndpoint.CloudIap)?.target
            ?: throw IllegalArgumentException("IapRelayDialer only accepts Cloud IAP targets")
        val backendToken = (target.credential as? Credential.LegacySharedToken)?.token
            ?: throw IllegalArgumentException("Cloud IAP TCP transport requires a legacy shared token")
        return IapLineConnection(
            iapTarget = iapTarget,
            backendToken = backendToken,
            callbacks = callbacks,
            tokenProvider = tokenProvider,
            relaySocketFactory = relaySocketFactory,
            scheduler = scheduler,
            connectTimeoutMs = connectTimeoutMs,
            queue = BoundedLineQueue(maxQueuedLines, maxQueuedUtf8Bytes),
        ).also(IapLineConnection::start)
    }
}

private class IapLineConnection(
    private val iapTarget: IapTarget,
    private val backendToken: String,
    private val callbacks: LineCallbacks,
    private val tokenProvider: IapAccessTokenProvider,
    private val relaySocketFactory: IapRelaySocketFactory,
    private val scheduler: TransportScheduler,
    private val connectTimeoutMs: Long,
    private val queue: BoundedLineQueue,
) : LineConnection, IapRelaySocketCallbacks {
    private val parser = IapRelayParser()
    private val decoder = Utf8NdjsonDecoder()
    private var tokenPending = false
    private var tokenRequest: Cancelable? = null
    private var timeout: Cancelable? = null
    private var relaySocket: IapRelaySocket? = null
    private var relayReady = false
    private var terminated = false
    private var receivedBytes = 0L
    private var acknowledgedBytes = 0L

    @Synchronized
    fun start() {
        if (terminated) return
        timeout = scheduler.schedule(connectTimeoutMs) {
            fail(IapRelayTimeoutException())
        }
        tokenPending = true
        val request = try {
            tokenProvider.request(::onAccessToken)
        } catch (error: Throwable) {
            terminated = true
            cleanup()
            throw error
        }
        if (tokenPending && !terminated) {
            tokenRequest = request
        } else {
            request.cancel()
        }
    }

    @Synchronized
    override fun send(text: String): Boolean {
        if (terminated) return false
        if (!relayReady) {
            if (queue.offer(text) == LineQueueOffer.Queued) return true
            fail(IapRelayQueueOverflowException())
            return false
        }
        if (sendLine(text)) return true
        fail(IapRelayProtocolException("IAP relay data send failed"))
        return false
    }

    @Synchronized
    override fun close() {
        if (terminated) return
        terminated = true
        cleanup()?.close()
    }

    @Synchronized
    private fun onAccessToken(result: IapAccessTokenResult) {
        if (terminated || !tokenPending) return
        tokenPending = false
        tokenRequest = null
        when (result) {
            is IapAccessTokenResult.Available -> {
                relaySocket = try {
                    val request = IapRelayRequestPolicy.build(iapTarget, result.token)
                    relaySocketFactory.open(request, this)
                } catch (error: Throwable) {
                    fail(error)
                    null
                }
            }
            IapAccessTokenResult.SignedOut -> fail(IapGoogleSignedOutException())
            IapAccessTokenResult.Blocked -> fail(IapGoogleCredentialsBlockedException())
            is IapAccessTokenResult.RetryableFailure ->
                fail(IapRetryableTokenException(result.reason))
        }
    }

    @Synchronized
    override fun onOpen(socket: IapRelaySocket) {
        if (!accepts(socket)) socket.close()
    }

    @Synchronized
    override fun onBinary(socket: IapRelaySocket, bytes: ByteArray) {
        if (!accepts(socket)) return
        when (val result = parser.push(bytes)) {
            is IapRelayParseResult.ProtocolError -> fail(IapRelayProtocolException(result.detail))
            is IapRelayParseResult.Frames -> result.frames.forEach { frame ->
                if (!terminated) receive(frame)
            }
        }
    }

    @Synchronized
    override fun onClosed(socket: IapRelaySocket, cause: DisconnectCause) {
        if (!accepts(socket)) return
        if (relayReady) {
            when (val terminal = decoder.finish()) {
                is Utf8NdjsonResult.ProtocolError -> {
                    fail(IapRelayProtocolException(terminal.detail))
                    return
                }
                is Utf8NdjsonResult.Lines -> terminal.lines.forEach(callbacks::onText)
            }
        }
        terminated = true
        cleanup(closeSocket = false)
        callbacks.onClosed(cause)
    }

    @Synchronized
    override fun onFailure(socket: IapRelaySocket, error: Throwable) {
        if (accepts(socket)) fail(error)
    }

    private fun receive(frame: IapRelayFrame) {
        when (frame) {
            is IapRelayFrame.ConnectSuccess -> connected()
            is IapRelayFrame.Data -> receiveData(frame.payload)
            is IapRelayFrame.Ack,
            is IapRelayFrame.ReconnectSuccess,
            -> Unit
        }
    }

    private fun connected() {
        if (relayReady) {
            fail(IapRelayProtocolException("duplicate IAP relay connect success"))
            return
        }
        val socket = relaySocket ?: return
        timeout?.cancel()
        timeout = null
        if (!sendLine(tcpHostAuthenticationLine(backendToken), appendNewline = true)) {
            fail(IapRelayProtocolException("IAP relay could not send backend authentication"))
            return
        }
        relayReady = true
        for (line in queue.drain()) {
            if (!sendLine(line)) {
                fail(IapRelayProtocolException("IAP relay could not flush queued data"))
                return
            }
        }
        if (!terminated && relaySocket === socket) callbacks.onOpen(this)
    }

    private fun receiveData(payload: ByteArray) {
        if (!relayReady) {
            fail(IapRelayProtocolException("IAP relay data arrived before connect success"))
            return
        }
        receivedBytes += payload.size
        when (val result = decoder.push(payload)) {
            is Utf8NdjsonResult.ProtocolError -> {
                fail(IapRelayProtocolException(result.detail))
                return
            }
            is Utf8NdjsonResult.Lines -> result.lines.forEach(callbacks::onText)
        }
        if (!terminated && receivedBytes - acknowledgedBytes >= ACK_INTERVAL_BYTES) {
            val socket = relaySocket ?: return
            if (!socket.send(IapRelayCodec.encodeAck(receivedBytes))) {
                fail(IapRelayProtocolException("IAP relay acknowledgement failed"))
                return
            }
            acknowledgedBytes = receivedBytes
        }
    }

    private fun sendLine(line: String, appendNewline: Boolean = true): Boolean {
        val socket = relaySocket ?: return false
        val wire = if (appendNewline && !line.endsWith('\n')) "$line\n" else line
        return IapRelayCodec.chunkData(wire.toByteArray(StandardCharsets.UTF_8))
            .all { socket.send(IapRelayCodec.encodeData(it)) }
    }

    @Synchronized
    private fun fail(error: Throwable) {
        if (terminated) return
        terminated = true
        cleanup()?.close()
        callbacks.onFailure(error)
    }

    private fun cleanup(closeSocket: Boolean = true): IapRelaySocket? {
        tokenRequest?.cancel()
        tokenRequest = null
        tokenPending = false
        timeout?.cancel()
        timeout = null
        queue.clear()
        relayReady = false
        return relaySocket.also { relaySocket = null }.takeIf { closeSocket }
    }

    private fun accepts(socket: IapRelaySocket): Boolean = !terminated && relaySocket === socket

    private companion object {
        const val ACK_INTERVAL_BYTES = 32_768L
    }
}

private fun tcpHostAuthenticationLine(token: String): String = JsonCodec.encode(
    JsonObject(
        linkedMapOf(
            "k" to JsonString("auth"),
            "token" to JsonString(token),
        ),
    ),
)

class IapRelayTimeoutException : RuntimeException("IAP relay connect timed out")

class IapRelayQueueOverflowException : RuntimeException("IAP relay pre-ready queue is full")

class IapGoogleSignedOutException : RuntimeException("Cloud IAP requires Google sign-in"), NonRetryableTransportFailure {
    override val reason = ConnectionTerminalReason.GoogleSignInRequired
}

class IapGoogleCredentialsBlockedException :
    RuntimeException("Cloud IAP Google credentials are blocked"),
    NonRetryableTransportFailure {
    override val reason = ConnectionTerminalReason.GoogleCredentialsBlocked
}

class IapRetryableTokenException(reason: String) :
    RuntimeException("Cloud IAP access token is temporarily unavailable") {
    init {
        require(reason.isNotBlank()) { "Cloud IAP retry reason is missing" }
    }
}

class IapRelayProtocolException(detail: String) : RuntimeException(detail)
