package app.switchboard.mobile.ui.pairing

import app.switchboard.mobile.domain.iap.IapDiscoveredTarget
import app.switchboard.mobile.domain.iap.IapTargetSelection
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingIapDiscoveryPolicyTest {
    @Test
    fun `presentation distinguishes loading available all-added and empty discovery`() {
        val target = IapDiscoveredTarget("work-vm", "vm-a", "project-a", "zone-a")

        assertEquals(IapDiscoveryPresentation.Loading, PairingIapDiscoveryPolicy.present(null))
        assertEquals(
            IapDiscoveryPresentation.Available(listOf(target)),
            PairingIapDiscoveryPolicy.present(IapTargetSelection(listOf(target), 1, 0)),
        )
        assertEquals(
            IapDiscoveryPresentation.AllAdded(2),
            PairingIapDiscoveryPolicy.present(IapTargetSelection(emptyList(), 2, 2)),
        )
        assertEquals(
            IapDiscoveryPresentation.Empty,
            PairingIapDiscoveryPolicy.present(IapTargetSelection(emptyList(), 0, 0)),
        )
    }
}
