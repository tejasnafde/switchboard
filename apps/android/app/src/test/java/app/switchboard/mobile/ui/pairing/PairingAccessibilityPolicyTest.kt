package app.switchboard.mobile.ui.pairing

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingAccessibilityPolicyTest {
    @Test
    fun fieldAndSaveStatesUseStableSpokenCopy() {
        assertEquals("Machine address", PairingAccessibilityPolicy.fieldDescription("Address"))
        assertEquals("Pairing token", PairingAccessibilityPolicy.fieldDescription("Token"))
        assertEquals("Saving machine", PairingAccessibilityPolicy.saveState(editing = true, saving = true))
        assertEquals("Connect machine", PairingAccessibilityPolicy.saveState(editing = false, saving = false))
    }

    @Test
    fun screenCopyUsesTaskLanguageForAddEditAndQrFlows() {
        assertEquals("Add machine", PairingPresentationPolicy.title(editing = false))
        assertEquals("Edit machine", PairingPresentationPolicy.title(editing = true))
        assertEquals("Scan connection code", PairingPresentationPolicy.qrTitle())
        assertEquals(
            "Connect securely",
            PairingPresentationPolicy.primaryAction(
                editing = false,
                kind = PairingConnectionKind.WEBSOCKET,
            ),
        )
    }
}
