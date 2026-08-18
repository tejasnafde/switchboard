package app.switchboard.mobile.runtime

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleTokenExchange
import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.platform.google.GoogleCredentialReadResult
import app.switchboard.mobile.platform.google.GoogleCredentialWriteResult
import app.switchboard.mobile.platform.google.GoogleNativeCredentialStore
import app.switchboard.mobile.platform.iap.IapRelayRequest
import app.switchboard.mobile.platform.iap.IapRelaySocket
import app.switchboard.mobile.platform.iap.IapRelaySocketCallbacks
import app.switchboard.mobile.platform.iap.IapRelaySocketFactory
import app.switchboard.mobile.platform.iap.IapGoogleCredentialsBlockedException
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.LineCallbacks
import app.switchboard.mobile.platform.protocol.LineConnection
import app.switchboard.mobile.platform.protocol.LineDialer
import app.switchboard.mobile.platform.protocol.LineEndpoint
import app.switchboard.mobile.platform.protocol.LineTarget
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeLineTransportCompositionTest {
    @Test
    fun `composition preserves direct routing and gives IAP the Google access token`() {
        val direct = RecordingDialer()
        val relay = RecordingRelayFactory()
        val store = FakeGoogleStore(
            GoogleCredentialReadResult.Available(
                GoogleCredentialBundle(
                    clientId = "client",
                    refreshToken = "refresh",
                    accessToken = "google-access",
                    expiresAtEpochMs = 300_000,
                ),
            ),
        )
        val dialer = composeNativeLineDialer(
            direct = direct,
            googleCredentials = store,
            tokenExchange = GoogleTokenExchange { _, _ -> error("fresh token must not refresh") },
            relaySocketFactory = relay,
            scheduler = NoOpScheduler,
            nowEpochMs = { 100_000 },
        )

        dialer.open(
            LineTarget("device", "ws", "wss://example.test", Credential.Session("session")),
            NoOpCallbacks,
        )
        dialer.open(
            LineTarget(
                deviceId = "device",
                connectionId = "iap",
                endpoint = LineEndpoint.CloudIap(IapTarget("project", "zone", "instance", 8766)),
                credential = Credential.LegacySharedToken("backend"),
            ),
            NoOpCallbacks,
        )

        assertEquals(listOf("ws"), direct.connectionIds)
        assertEquals("Bearer google-access", relay.requests.single().header("Authorization"))
    }

    @Test
    fun `composition blocks IAP before relay dial when encrypted Google credentials are unreadable`() {
        val direct = RecordingDialer()
        val relay = RecordingRelayFactory()
        val store = FakeGoogleStore(GoogleCredentialReadResult.Blocked("secret-bearing detail"))
        val failures = mutableListOf<Throwable>()
        val dialer = composeNativeLineDialer(
            direct = direct,
            googleCredentials = store,
            tokenExchange = GoogleTokenExchange { _, _ -> error("must not refresh") },
            relaySocketFactory = relay,
            scheduler = NoOpScheduler,
            nowEpochMs = { 100_000 },
        )

        dialer.open(
            LineTarget("device", "ws", "wss://example.test", Credential.Session("session")),
            NoOpCallbacks,
        )
        dialer.open(
            LineTarget(
                deviceId = "device",
                connectionId = "iap",
                endpoint = LineEndpoint.CloudIap(IapTarget("project", "zone", "instance", 8766)),
                credential = Credential.LegacySharedToken("backend"),
            ),
            object : LineCallbacks by NoOpCallbacks {
                override fun onFailure(error: Throwable) {
                    failures += error
                }
            },
        )

        assertTrue(relay.requests.isEmpty())
        assertEquals(listOf("ws"), direct.connectionIds)
        assertTrue(failures.single() is IapGoogleCredentialsBlockedException)
        assertEquals("Cloud IAP Google credentials are blocked", failures.single().message)
        assertFalse(failures.single().toString().contains("secret-bearing"))
    }

    private class FakeGoogleStore(
        var status: GoogleCredentialReadResult,
    ) : GoogleNativeCredentialStore {
        override val bundle: GoogleCredentialBundle?
            get() = (status as? GoogleCredentialReadResult.Available)?.credentials

        override fun readStatus(): GoogleCredentialReadResult = status
        override fun writeAndVerify(credentials: GoogleCredentialBundle) = GoogleCredentialWriteResult.Verified
        override fun replace(expected: GoogleCredentialBundle, replacement: GoogleCredentialBundle) = false
        override fun clearNativeOwned(expected: GoogleCredentialBundle?) = false
    }

    private class RecordingDialer : LineDialer {
        val connectionIds = mutableListOf<String>()
        override fun open(target: LineTarget, callbacks: LineCallbacks): LineConnection {
            connectionIds += target.connectionId
            return NoOpConnection
        }
    }

    private class RecordingRelayFactory : IapRelaySocketFactory {
        val requests = mutableListOf<IapRelayRequest>()
        override fun open(request: IapRelayRequest, callbacks: IapRelaySocketCallbacks): IapRelaySocket {
            requests += request
            return object : IapRelaySocket {
                override fun send(bytes: ByteArray) = true
                override fun close() = Unit
            }
        }
    }

    private object NoOpScheduler : TransportScheduler {
        override fun schedule(delayMs: Long, block: () -> Unit) = Cancelable {}
    }

    private object NoOpConnection : LineConnection {
        override fun send(text: String) = true
        override fun close() = Unit
    }

    private object NoOpCallbacks : LineCallbacks {
        override fun onOpen(connection: LineConnection) = Unit
        override fun onText(text: String) = Unit
        override fun onClosed(cause: DisconnectCause) = Unit
        override fun onFailure(error: Throwable) = Unit
    }
}
