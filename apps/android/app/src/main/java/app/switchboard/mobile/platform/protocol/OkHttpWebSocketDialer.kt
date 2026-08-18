package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.DisconnectCause
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class OkHttpWebSocketDialer(
    private val client: OkHttpClient = OkHttpClient(),
) : WebSocketDialer {
    override fun open(
        target: WebSocketTarget,
        callbacks: WebSocketCallbacks,
    ): WebSocketConnection {
        val direct = target.endpoint as? LineEndpoint.DirectWebSocket
            ?: throw IllegalArgumentException("OkHttpWebSocketDialer only accepts direct WebSocket targets")
        val cleanUrl = withoutEmbeddedAuth(direct.url)
        val dialUrl = when (val credential = target.credential) {
            is app.switchboard.mobile.protocol.Credential.LegacySharedToken ->
                legacyAuthenticatedUrl(cleanUrl, credential.token)
            else -> cleanUrl
        }
        val request = Request.Builder().url(dialUrl).build()
        val webSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    callbacks.onOpen(OkHttpConnection(webSocket))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    callbacks.onText(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    callbacks.onClosed(DisconnectCause.Server)
                }

                override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                ) {
                    callbacks.onFailure(t)
                }
            },
        )
        return OkHttpConnection(webSocket)
    }

    private class OkHttpConnection(
        private val webSocket: WebSocket,
    ) : WebSocketConnection {
        override fun send(text: String): Boolean = webSocket.send(text)

        override fun close() {
            webSocket.close(NORMAL_CLOSURE, "client lifecycle")
        }
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
    }
}
