package app.switchboard.mobile.ui.connections

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionsAccessibilityPolicyTest {
    @Test
    fun machineDescriptionKeepsIdentityTargetAndFailureState() {
        val row = ConnectionRowPresentation(
            id = "machine-1",
            label = "Studio",
            kind = ConnectionKind.WEBSOCKET,
            target = "studio.local:8765",
            status = ConnectionStatus.ERROR,
            statusLabel = "error",
            live = false,
            showProgress = false,
            detail = "Pairing expired",
        )

        assertEquals(
            "Studio, studio.local:8765",
            ConnectionsAccessibilityPolicy.contentDescription(row),
        )
        assertEquals(
            "error, Pairing expired",
            ConnectionsAccessibilityPolicy.stateDescription(row),
        )
        assertEquals("Show actions for Studio", ConnectionsAccessibilityPolicy.longClickLabel(row))
    }
}
