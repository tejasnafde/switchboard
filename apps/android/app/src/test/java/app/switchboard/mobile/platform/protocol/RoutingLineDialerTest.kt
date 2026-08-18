package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DisconnectCause
import org.junit.Assert.assertEquals
import org.junit.Test

class RoutingLineDialerTest {
    @Test
    fun `routes direct and IAP endpoints without synthesizing a URL`() {
        val direct = RecordingDialer("direct")
        val iap = RecordingDialer("iap")
        val routing = RoutingLineDialer(direct, iap)
        val callbacks = NoOpCallbacks()

        routing.open(
            LineTarget("device", "direct-id", "ws://localhost:8765", Credential.LegacySharedToken("a")),
            callbacks,
        )
        routing.open(
            LineTarget(
                deviceId = "device",
                connectionId = "iap-id",
                endpoint = LineEndpoint.CloudIap(IapTarget("project", "zone", "instance", 8766)),
                credential = Credential.LegacySharedToken("b"),
            ),
            callbacks,
        )

        assertEquals(listOf("direct:direct-id"), direct.calls)
        assertEquals(listOf("iap:iap-id"), iap.calls)
    }

    private class RecordingDialer(private val label: String) : LineDialer {
        val calls = mutableListOf<String>()
        override fun open(target: LineTarget, callbacks: LineCallbacks): LineConnection {
            calls += "$label:${target.connectionId}"
            return object : LineConnection {
                override fun send(text: String) = true
                override fun close() = Unit
            }
        }
    }

    private class NoOpCallbacks : LineCallbacks {
        override fun onOpen(connection: LineConnection) = Unit
        override fun onText(text: String) = Unit
        override fun onClosed(cause: DisconnectCause) = Unit
        override fun onFailure(error: Throwable) = Unit
    }
}
