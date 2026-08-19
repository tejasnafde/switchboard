package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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

        credentials.forEach { (credential, expectedPath) ->
            MockWebServer().use { server ->
                server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {}))
                val dialer = OkHttpWebSocketDialer(OkHttpClient())
                val connection = dialer.open(
                    target(server, credential),
                    NoOpCallbacks,
                )

                assertEquals(expectedPath, server.takeRequest(3, TimeUnit.SECONDS)?.path)
                connection.close()
            }
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
