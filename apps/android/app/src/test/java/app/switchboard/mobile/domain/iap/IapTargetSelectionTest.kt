package app.switchboard.mobile.domain.iap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IapTargetSelectionTest {
    @Test
    fun `discovery preserves source order and first alias while deduping target identity`() {
        val first = IapDiscoveredTarget("work-a", "vm", "project", "zone")
        val duplicate = first.copy(alias = "other-alias")
        val second = IapDiscoveredTarget("work-b", "vm-2", "project", "zone")

        assertEquals(
            listOf(first, second),
            IapTargetDiscovery.merge(listOf(listOf(first), emptyList(), listOf(duplicate, second))),
        )
    }

    @Test
    fun `manual target trims fields and accepts the canonical default port`() {
        assertEquals(
            IapManualTargetResult.Valid(
                IapTarget(project = "project", zone = "asia-south1-b", instance = "work-vm", port = 8766),
            ),
            IapManualTargetPolicy.validate(
                project = " project ",
                zone = " asia-south1-b ",
                instance = " work-vm ",
                port = "8766",
            ),
        )
    }

    @Test
    fun `manual target rejects blank identity and ports outside TCP range`() {
        assertTrue(
            IapManualTargetPolicy.validate("", "zone", "vm", "8766") is IapManualTargetResult.Invalid,
        )
        assertTrue(
            IapManualTargetPolicy.validate("project", "zone", "vm", "0") is IapManualTargetResult.Invalid,
        )
        assertTrue(
            IapManualTargetPolicy.validate("project", "zone", "vm", "65536") is IapManualTargetResult.Invalid,
        )
        assertTrue(
            IapManualTargetPolicy.validate("project", "zone", "vm", "not-a-port") is IapManualTargetResult.Invalid,
        )
    }
}
