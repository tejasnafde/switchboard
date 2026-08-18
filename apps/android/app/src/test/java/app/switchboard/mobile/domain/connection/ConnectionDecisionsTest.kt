package app.switchboard.mobile.domain.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionDecisionsTest {
    @Test
    fun `pairing code wins over a legacy shared token`() {
        assertEquals(
            PairingTarget(
                endpoint = "ws://192.168.1.8:8765",
                token = null,
                pairingCode = "abc 123",
            ),
            PairingUrl.parse(" ws://192.168.1.8:8765/?token=shared&pair=abc%20123 "),
        )
    }

    @Test
    fun `legacy token and bare websocket endpoints remain compatible`() {
        assertEquals(
            PairingTarget("wss://switchboard.example/ws", "shared+token", null),
            PairingUrl.parse("wss://switchboard.example/ws?token=shared%2Btoken"),
        )
        assertEquals(
            PairingTarget("ws://host:8765", null, null),
            PairingUrl.parse("ws://host:8765"),
        )
    }

    @Test
    fun `credentials never remain embedded in the dial endpoint`() {
        val parsed = PairingUrl.parse("ws://host:8765/path?token=secret#device")

        assertEquals("ws://host:8765/path#device", parsed?.endpoint)
        assertEquals("secret", parsed?.token)
    }

    @Test
    fun `non websocket and malformed values are rejected`() {
        assertNull(PairingUrl.parse("https://example.com?token=secret"))
        assertNull(PairingUrl.parse("WS://host:8765"))
        assertNull(PairingUrl.parse("ws://"))
        assertNull(PairingUrl.parse("not a url"))
        assertNull(PairingUrl.parse(""))
    }

    @Test
    fun `foreground decision probes short absences and reconnects at threshold`() {
        assertEquals(ForegroundAction.Probe, ConnectionLifecycle.foregroundAction(null, 50_000))
        assertEquals(ForegroundAction.Probe, ConnectionLifecycle.foregroundAction(1_000, 10_999))
        assertEquals(ForegroundAction.Reconnect, ConnectionLifecycle.foregroundAction(1_000, 11_000))
        assertEquals(ForegroundAction.Reconnect, ConnectionLifecycle.foregroundAction(1_000, 61_000))
    }

    @Test
    fun `network reachability follows local link connectivity not WAN validation`() {
        assertEquals(true, ConnectionLifecycle.canReachLocalBackend(isConnected = true))
        assertEquals(false, ConnectionLifecycle.canReachLocalBackend(isConnected = false))
        assertEquals(true, ConnectionLifecycle.canReachLocalBackend(isConnected = null))
    }

    @Test
    fun `IAP validation requires target fields and a valid port`() {
        assertEquals(
            IapTarget("project", "zone", "instance", 8766),
            IapTargetValidator.validate(" project ", " zone ", " instance ", "8766").getOrNull(),
        )
        assertEquals(IapTargetError.MissingDetails, IapTargetValidator.validate("", "zone", "vm", "8766").exceptionOrNull())
        assertEquals(IapTargetError.InvalidPort, IapTargetValidator.validate("p", "z", "vm", "0").exceptionOrNull())
        assertEquals(IapTargetError.InvalidPort, IapTargetValidator.validate("p", "z", "vm", "70000").exceptionOrNull())
        assertEquals(IapTargetError.InvalidPort, IapTargetValidator.validate("p", "z", "vm", "abc").exceptionOrNull())
    }

    @Test
    fun `connection status exposes reconnect and authentication detail`() {
        val connecting = ConnectionStatusReducer.reduce(null, ConnectionRuntimeEvent.Begin(generation = 4))
        val retrying = ConnectionStatusReducer.reduce(
            connecting,
            ConnectionRuntimeEvent.Retrying(generation = 4, closeCode = 1006, attempt = 2),
        )
        val rejected = ConnectionStatusReducer.reduce(
            retrying,
            ConnectionRuntimeEvent.Stopped(generation = 4, authenticationRejected = true),
        )

        assertEquals(ConnectionStatus.Connecting, retrying?.status)
        assertEquals("dropped (1006), retry 2", retrying?.detail)
        assertEquals(ConnectionStatus.Error, rejected?.status)
        assertEquals("token rejected - re-pair", rejected?.detail)
    }

    @Test
    fun `callbacks from an older transport generation cannot change current status`() {
        val current = ConnectionRuntimeState(8, ConnectionStatus.Connecting, "retry 1")

        assertEquals(
            current,
            ConnectionStatusReducer.reduce(current, ConnectionRuntimeEvent.Ready(generation = 7)),
        )
        assertEquals(
            ConnectionRuntimeState(8, ConnectionStatus.Connected, ""),
            ConnectionStatusReducer.reduce(current, ConnectionRuntimeEvent.Ready(generation = 8)),
        )
        assertEquals(
            current,
            ConnectionStatusReducer.reduce(current, ConnectionRuntimeEvent.Ready(generation = 9)),
        )
    }

    @Test
    fun `duplicate connect intent cannot demote an already ready generation`() {
        val ready = ConnectionRuntimeState(3, ConnectionStatus.Connected, "")

        assertEquals(ready, ConnectionStatusReducer.reduce(ready, ConnectionRuntimeEvent.Begin(3)))
        assertEquals(
            ConnectionRuntimeState(4, ConnectionStatus.Connecting, ""),
            ConnectionStatusReducer.reduce(ready, ConnectionRuntimeEvent.Begin(4)),
        )
    }
}
