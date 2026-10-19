package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OkHttpWebSocketDialerTest {
    @Test
    fun sessionAndPairingDeclareFrameAuthWhileLegacyUsesOnlyToken() {
        val credentials = listOf(
            Credential.Session("session-secret") to "/socket?workspace=one&auth=frame",
            Credential.Pairing("pair-secret", "Phone") to "/socket?workspace=one&auth=frame",
            Credential.LegacySharedToken("legacy secret") to "/socket?workspace=one&token=legacy%20secret",
        )

        MockWebServer().use { server ->
            val dialer = OkHttpWebSocketDialer(OkHttpClient())
            credentials.forEach { (credential, expectedPath) ->
                server.enqueue(MockResponse().setResponseCode(400))
                dialer.open(
                    target(server, credential),
                    NoOpCallbacks,
                )

                assertEquals(expectedPath, server.takeRequest(3, TimeUnit.SECONDS)?.path)
            }
        }
    }

    @Test
    fun socketsPingSoAHalfOpenConnectionFailsAndSharesTheBaseDispatcher() {
        val base = OkHttpClient()
        assertEquals(OkHttpWebSocketDialer.PING_INTERVAL_MS.toInt(), OkHttpWebSocketDialer(base).client.pingIntervalMillis)
        assertTrue(OkHttpWebSocketDialer(base).client.dispatcher === base.dispatcher)

        // A peer that completes the upgrade and then goes silent, as a socket
        // left behind by a network move does: no close, no error, no pong.
        ServerSocket(0).use { listener ->
            thread(isDaemon = true) {
                runCatching {
                    val peer = listener.accept()
                    val request = peer.getInputStream().bufferedReader()
                    val key = generateSequence { request.readLine() }
                        .takeWhile { it.isNotEmpty() }
                        .first { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
                        .substringAfter(":").trim()
                    val accept = Base64.getEncoder().encodeToString(
                        MessageDigest.getInstance("SHA-1")
                            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()),
                    )
                    peer.getOutputStream().write(
                        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
                            "Connection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n").toByteArray(),
                    )
                    peer.getOutputStream().flush()
                    Thread.sleep(10_000)
                }
            }
            val failed = CountDownLatch(1)
            val opened = CountDownLatch(1)
            OkHttpWebSocketDialer(base, pingIntervalMs = 200).open(
                WebSocketTarget(
                    deviceId = "phone",
                    connectionId = "machine",
                    endpoint = LineEndpoint.DirectWebSocket("ws://127.0.0.1:${listener.localPort}/socket"),
                    credential = Credential.Session("session-secret"),
                ),
                object : LineCallbacks {
                    override fun onOpen(connection: LineConnection) = opened.countDown()
                    override fun onText(text: String) = Unit
                    override fun onClosed(cause: DisconnectCause) = Unit
                    override fun onFailure(error: Throwable) = failed.countDown()
                },
            )

            assertTrue(opened.await(5, TimeUnit.SECONDS))
            assertTrue(failed.await(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun closeCode4001IsAuthenticationRejectedAndDoesNotAlsoReportServerClose() {
        MockWebServer().use { server ->
            val closed = CountDownLatch(1)
            val causes = mutableListOf<DisconnectCause>()
            server.enqueue(
                MockResponse().withWebSocketUpgrade(
                    object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            webSocket.close(4001, "unauthorized")
                        }
                    },
                ),
            )

            OkHttpWebSocketDialer(OkHttpClient()).open(
                target(server, Credential.Session("session-secret")),
                object : LineCallbacks {
                    override fun onOpen(connection: LineConnection) = Unit
                    override fun onText(text: String) = Unit
                    override fun onClosed(cause: DisconnectCause) {
                        causes += cause
                        closed.countDown()
                    }
                    override fun onFailure(error: Throwable) = Unit
                },
            )

            assertTrue(closed.await(3, TimeUnit.SECONDS))
            assertEquals(listOf(DisconnectCause.AuthenticationRejected), causes)
        }
    }

    private fun target(server: MockWebServer, credential: Credential): LineTarget = LineTarget(
        deviceId = "phone",
        connectionId = "machine",
        endpoint = LineEndpoint.DirectWebSocket(
            server.url("/socket?workspace=one&token=stale&pair=stale&auth=stale")
                .toString()
                .replaceFirst("http://", "ws://"),
        ),
        credential = credential,
    )

    private object NoOpCallbacks : LineCallbacks {
        override fun onOpen(connection: LineConnection) = Unit
        override fun onText(text: String) = Unit
        override fun onClosed(cause: DisconnectCause) = Unit
        override fun onFailure(error: Throwable) = Unit
    }
}
