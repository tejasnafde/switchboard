package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.domain.connection.ConnectionTerminalReason
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone dials the desktop's self-signed certificate over wss:// only when it
 * matches the pin from the QR. The fixture was minted by the desktop's own
 * generator (src/main/backend/tls.ts), so this also proves the JVM's TLS
 * accepts that certificate's encoding. Test-only key: it protects nothing.
 */
class PinnedTlsTest {
    @Test
    fun dialsTheBackendWhoseCertificateMatchesThePin() {
        val outcome = dial(PIN)
        assertEquals("open", outcome.event)
        assertTrue("the pin is not sent to the backend", outcome.path?.contains("fp=") == false)
    }

    @Test
    fun aChangedCertificateIsAHardErrorThatNeverRetries() {
        val outcome = dial(OTHER_PIN)
        assertEquals("failure", outcome.event)
        val failure = outcome.error as CertificateChangedFailure
        assertEquals(ConnectionTerminalReason.CertificateChanged, failure.reason)
    }

    @Test
    fun theTrustManagerChecksOnlyTheLeafFingerprint() {
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(CERT_PEM.byteInputStream()) as java.security.cert.X509Certificate
        assertEquals(PIN, certificateFingerprint(certificate))
        PinnedCertificateTrustManager(PIN).checkServerTrusted(arrayOf(certificate), "ECDHE_ECDSA")
        val mismatch = runCatching {
            PinnedCertificateTrustManager(OTHER_PIN).checkServerTrusted(arrayOf(certificate), "ECDHE_ECDSA")
        }.exceptionOrNull()
        assertTrue(mismatch is CertificatePinMismatch)
    }

    private data class Outcome(val event: String, val error: Throwable?, val path: String?)

    private fun dial(pin: String): Outcome {
        MockWebServer().use { server ->
            server.useHttps(serverContext().socketFactory, false)
            server.enqueue(
                MockResponse().withWebSocketUpgrade(
                    object : WebSocketListener() {
                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                            webSocket.close(code, null)
                        }
                    },
                ),
            )
            val done = CountDownLatch(1)
            val result = AtomicReference<Pair<String, Throwable?>>()
            val url = server.url("/").toString().replaceFirst("https://", "wss://").removeSuffix("/") + "?fp=$pin"
            val connection = OkHttpWebSocketDialer(OkHttpClient()).open(
                LineTarget("phone", "machine", LineEndpoint.DirectWebSocket(url), Credential.Session("s")),
                object : LineCallbacks {
                    override fun onOpen(connection: LineConnection) {
                        result.set("open" to null)
                        done.countDown()
                    }
                    override fun onText(text: String) = Unit
                    override fun onClosed(cause: DisconnectCause) = Unit
                    override fun onFailure(error: Throwable) {
                        result.set("failure" to error)
                        done.countDown()
                    }
                },
            )
            assertTrue(done.await(5, TimeUnit.SECONDS))
            connection.close()
            val (event, error) = result.get()
            val path = if (event == "open") server.takeRequest(1, TimeUnit.SECONDS)?.path else null
            return Outcome(event, error, path)
        }
    }

    private fun serverContext(): SSLContext {
        val factory = CertificateFactory.getInstance("X.509")
        val certificate = factory.generateCertificate(CERT_PEM.byteInputStream())
        val der = Base64.getMimeDecoder().decode(
            KEY_PEM.lines().filterNot { it.startsWith("-----") }.joinToString(""),
        )
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setKeyEntry("backend", key, CharArray(0), arrayOf(certificate))
        }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
            init(store, CharArray(0))
        }
        return SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
    }

    private companion object {
        const val PIN = "0cfd2c0504c0fda391260e613cf13267608295c28003a4f5af0cab3b4a275aff"
        const val OTHER_PIN = "71dc4a1e33fc1b019efdaa6b4d13792efd1ddfbf1aeea2875bdc5779379ee96e"
        val CERT_PEM = """
-----BEGIN CERTIFICATE-----
MIIBKDCB0KADAgECAhAdtmDsMtVsm3yfyLgX+spcMAoGCCqGSM49BAMCMBYxFDAS
BgNVBAMMC1N3aXRjaGJvYXJkMCAXDTI2MTAxNDA5MjQwNVoYDzIwOTkxMjMxMjM1
OTU5WjAWMRQwEgYDVQQDDAtTd2l0Y2hib2FyZDBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABNTk4JkbdBB1rK//j/7UKTyGA74gT0NDHN4WIptOPb51AXGHr8fvcnxV
ojiUa6Vi6HDfVPtRGAknBwhHzrOxzPMwCgYIKoZIzj0EAwIDRwAwRAIgB4fiWr7u
mnsVkLruBGEmTmR7ejGo0uMZryMuKi2hiI0CIFwL5/Ki09F+KsHwQ2w10cXC2tby
P7NkO37JJS5TgVQn
-----END CERTIFICATE-----
""".trimIndent()
        val KEY_PEM = """
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0dKeG59wl0U8gekd
wpIT35Luq7LFAaI1MC81QcuVspmhRANCAATU5OCZG3QQdayv/4/+1Ck8hgO+IE9D
QxzeFiKbTj2+dQFxh6/H73J8VaI4lGulYuhw31T7URgJJwcIR86zsczz
-----END PRIVATE KEY-----
""".trimIndent()
    }
}
