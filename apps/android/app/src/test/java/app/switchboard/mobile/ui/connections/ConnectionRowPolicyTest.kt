package app.switchboard.mobile.ui.connections

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionRowPolicyTest {
    @Test
    fun statusLabelsAreCompactAndHumanReadable() {
        assertEquals("Live", ConnectionRowPolicy.statusLabel(ConnectionStatus.LIVE))
        assertEquals("Connecting", ConnectionRowPolicy.statusLabel(ConnectionStatus.CONNECTING))
        assertEquals("Offline", ConnectionRowPolicy.statusLabel(ConnectionStatus.OFFLINE))
        assertEquals("Error", ConnectionRowPolicy.statusLabel(ConnectionStatus.ERROR))
    }

    @Test
    fun supportingTextKeepsFailureDetailWithoutRepeatingHealthyStatus() {
        assertEquals(
            "studio.local:8765",
            ConnectionRowPolicy.supportingText(row(ConnectionStatus.LIVE)),
        )
        assertEquals(
            "studio.local:8765 · Token rejected",
            ConnectionRowPolicy.supportingText(row(ConnectionStatus.ERROR, "Token rejected")),
        )
    }

    private fun row(status: ConnectionStatus, detail: String? = null) = ConnectionRowPresentation(
        id = "studio",
        label = "Studio",
        kind = ConnectionKind.WEBSOCKET,
        target = "studio.local:8765",
        status = status,
        statusLabel = status.name.lowercase(),
        live = status == ConnectionStatus.LIVE,
        showProgress = status == ConnectionStatus.CONNECTING,
        detail = detail,
    )
}
