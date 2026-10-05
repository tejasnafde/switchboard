package app.switchboard.mobile.domain.iap

import org.junit.Assert.assertEquals
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
    fun `selection merges sources and removes targets already saved on this phone`() {
        val first = IapDiscoveredTarget("work-a", "vm-a", "Project-A", "asia-south1-b")
        val duplicate = IapDiscoveredTarget("another-alias", "VM-A", " project-a ", "ASIA-SOUTH1-B")
        val available = IapDiscoveredTarget("work-b", "vm-b", "project-b", "us-central1-a")

        assertEquals(
            IapTargetSelection(
                available = listOf(available),
                discoveredCount = 2,
                alreadyAddedCount = 1,
            ),
            IapTargetDiscovery.select(
                sources = listOf(listOf(first), listOf(duplicate, available)),
                saved = listOf(IapTarget("project-a", "asia-south1-b", "vm-a", 8766)),
            ),
        )
    }

    @Test
    fun `selection distinguishes all-added targets from no discovery`() {
        val target = IapDiscoveredTarget("work-a", "vm-a", "project-a", "zone-a")

        assertEquals(
            IapTargetSelection(emptyList(), discoveredCount = 1, alreadyAddedCount = 1),
            IapTargetDiscovery.select(
                sources = listOf(listOf(target)),
                saved = listOf(IapTarget("project-a", "zone-a", "vm-a", 8766)),
            ),
        )
        assertEquals(
            IapTargetSelection(emptyList(), discoveredCount = 0, alreadyAddedCount = 0),
            IapTargetDiscovery.select(emptyList(), emptyList()),
        )
    }
}
