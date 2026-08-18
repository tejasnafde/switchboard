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
}
