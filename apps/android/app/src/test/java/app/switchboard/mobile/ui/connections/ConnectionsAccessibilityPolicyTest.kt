package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.domain.connection.ConnectionSecurity
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
            "error, Not encrypted, Pairing expired",
            ConnectionsAccessibilityPolicy.stateDescription(row),
        )
        assertEquals("Show actions for Studio", ConnectionsAccessibilityPolicy.longClickLabel(row))
        assertEquals("Open Studio", ConnectionsAccessibilityPolicy.clickLabel(row))

        val changed = row.copy(security = ConnectionSecurity.CERTIFICATE_CHANGED, shortFingerprint = "7c0e51b2")
        assertEquals("error, Certificate changed, 7c0e51b2", ConnectionsAccessibilityPolicy.stateDescription(changed))
        assertEquals("Show what changed on Studio", ConnectionsAccessibilityPolicy.clickLabel(changed))
    }
}
