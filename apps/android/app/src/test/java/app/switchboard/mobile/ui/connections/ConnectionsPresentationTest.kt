package app.switchboard.mobile.ui.connections

import org.junit.Assert.assertEquals
import app.switchboard.mobile.domain.connection.ConnectionSecurity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionsPresentationTest {
    @Test
    fun presentsLoadingEmptyFailureAndRecoverableContentWithoutInventingRows() {
        assertEquals(ConnectionsPresentation.Loading, ConnectionsPresenter.present(ConnectionsLoadState.Loading))
        assertEquals(
            ConnectionsPresentation.Empty,
            ConnectionsPresenter.present(ConnectionsLoadState.Ready(emptyList())),
        )
        assertEquals(
            ConnectionsPresentation.Failure("Storage unavailable"),
            ConnectionsPresenter.present(ConnectionsLoadState.Failed("Storage unavailable")),
        )

        val content = ConnectionsPresenter.present(
            ConnectionsLoadState.Ready(
                connections = listOf(ws(ConnectionStatus.OFFLINE), iap(ConnectionStatus.LIVE)),
                recoveryMessage = "Some machines could not reconnect",
            ),
        ) as ConnectionsPresentation.Content
        assertEquals("1 of 2", content.summary)
        assertEquals("Some machines could not reconnect", content.recoveryMessage)
    }

    @Test
    fun rowPresentationPreservesTargetAndEveryStatusMeaning() {
        val live = ConnectionsPresenter.row(ws(ConnectionStatus.LIVE))
        val connecting = ConnectionsPresenter.row(ws(ConnectionStatus.CONNECTING))
        val offline = ConnectionsPresenter.row(ws(ConnectionStatus.OFFLINE))
        val error = ConnectionsPresenter.row(ws(ConnectionStatus.ERROR, "token rejected - re-pair"))

        assertEquals("192.168.1.8:8765", live.target)
        assertEquals("live", live.statusLabel)
        assertTrue(live.live)
        assertEquals("connecting", connecting.statusLabel)
        assertTrue(connecting.showProgress)
        assertEquals("offline", offline.statusLabel)
        assertEquals("error", error.statusLabel)
        assertEquals("token rejected - re-pair", error.detail)
        assertEquals("work-vm  asia-south1-b", ConnectionsPresenter.row(iap(ConnectionStatus.LIVE)).target)
    }

    @Test
    fun rowPresentationCarriesTransportSecurityAndTheShortFingerprint() {
        val fp = "3f9a2c71" + "b".repeat(56)
        val pinned = ConnectionsPresenter.row(
            ws(ConnectionStatus.LIVE).copy(target = ConnectionTarget.WebSocket("wss://192.168.1.24:8765?fp=$fp")),
            requireEncryption = true,
        )
        assertEquals(ConnectionSecurity.PINNED, pinned.security)
        assertEquals("3f9a2c71", pinned.shortFingerprint)
        assertEquals("192.168.1.24:8765", pinned.address)

        val refused = ConnectionsPresenter.row(ws(ConnectionStatus.ERROR), requireEncryption = true)
        assertEquals(ConnectionSecurity.REFUSED, refused.security)
        assertNull(refused.shortFingerprint)
        assertEquals(ConnectionSecurity.PLAIN, ConnectionsPresenter.row(ws(ConnectionStatus.LIVE)).security)

        val changed = ConnectionsPresenter.row(
            ws(ConnectionStatus.ERROR).copy(
                target = ConnectionTarget.WebSocket("wss://192.168.1.40:8765?fp=$fp"),
                certificateChanged = true,
            ),
            requireEncryption = true,
        )
        assertEquals(ConnectionSecurity.CERTIFICATE_CHANGED, changed.security)
        assertEquals("3f9a2c71", changed.shortFingerprint)

        val iap = ConnectionsPresenter.row(iap(ConnectionStatus.LIVE))
        assertEquals(ConnectionSecurity.IAP, iap.security)
        assertEquals("asia-south1-b", iap.address)
    }

    @Test
    fun longPressActionsUseAbsoluteConnectDisconnectSemanticsAndDestructiveRemove() {
        val live = ConnectionsPresenter.actions(ws(ConnectionStatus.LIVE))
        val connecting = ConnectionsPresenter.actions(ws(ConnectionStatus.CONNECTING))
        val offline = ConnectionsPresenter.actions(ws(ConnectionStatus.OFFLINE))

        assertTrue(live.any { it.kind == ConnectionActionKind.DISCONNECT })
        assertTrue(connecting.any { it.kind == ConnectionActionKind.DISCONNECT })
        assertTrue(offline.any { it.kind == ConnectionActionKind.CONNECT })
        assertFalse(offline.any { it.kind == ConnectionActionKind.DISCONNECT })
        assertEquals(
            ConnectionActionStyle.DESTRUCTIVE,
            offline.single { it.kind == ConnectionActionKind.REMOVE }.style,
        )
        assertEquals(ConnectionActionKind.CANCEL, offline.last().kind)
    }

    private fun ws(status: ConnectionStatus, detail: String? = null) = ConnectionItem(
        id = "ws-1",
        label = "Studio",
        kind = ConnectionKind.WEBSOCKET,
        target = ConnectionTarget.WebSocket("ws://192.168.1.8:8765"),
        status = status,
        detail = detail,
    )

    private fun iap(status: ConnectionStatus) = ConnectionItem(
        id = "iap-1",
        label = "Work",
        kind = ConnectionKind.IAP,
        target = ConnectionTarget.Iap(instance = "work-vm", zone = "asia-south1-b"),
        status = status,
    )
}
