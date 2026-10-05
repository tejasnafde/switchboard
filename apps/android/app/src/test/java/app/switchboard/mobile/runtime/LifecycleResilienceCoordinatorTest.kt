package app.switchboard.mobile.runtime

import app.switchboard.mobile.domain.connection.ForegroundAction
import org.junit.Assert.assertEquals
import org.junit.Test

class LifecycleResilienceCoordinatorTest {
    @Test
    fun `short foreground absence renews viewing wakes outbox then probes`() {
        val calls = mutableListOf<String>()
        var now = 1_000L
        val coordinator = LifecycleResilienceCoordinator(
            clock = { now },
            onNetworkChanged = { calls += "network:$it" },
            onForegroundAction = { calls += "fleet:$it" },
            wakeOutbox = { calls += "outbox" },
            renewViewingLeases = { calls += "viewing" },
        )

        coordinator.onBackground()
        now = 10_999L
        coordinator.onForeground()

        assertEquals(
            listOf("viewing", "outbox", "fleet:${ForegroundAction.Probe}"),
            calls,
        )
    }

    @Test
    fun `threshold foreground absence reconnects and duplicate foreground is ignored`() {
        val calls = mutableListOf<String>()
        var now = 1_000L
        val coordinator = LifecycleResilienceCoordinator(
            clock = { now },
            onNetworkChanged = {},
            onForegroundAction = { calls += it.name },
            wakeOutbox = { calls += "outbox" },
            renewViewingLeases = { calls += "viewing" },
        )

        coordinator.onBackground()
        now = 11_000L
        coordinator.onForeground()
        coordinator.onForeground()

        assertEquals(listOf("viewing", "outbox", ForegroundAction.Reconnect.name), calls)
    }

    @Test
    fun `network regain wakes outbox while duplicate states do nothing`() {
        val calls = mutableListOf<String>()
        val coordinator = LifecycleResilienceCoordinator(
            clock = { 0 },
            onNetworkChanged = { calls += "network:$it" },
            onForegroundAction = {},
            wakeOutbox = { calls += "outbox" },
            renewViewingLeases = {},
        )

        coordinator.onNetworkAvailability(false)
        coordinator.onNetworkAvailability(false)
        coordinator.onNetworkAvailability(true)
        coordinator.onNetworkAvailability(true)

        assertEquals(listOf("network:false", "network:true", "outbox"), calls)
    }

    @Test
    fun `viewing renewal hooks isolate failures and unregister cleanly`() {
        val calls = mutableListOf<String>()
        val hooks = ViewingLeaseRenewalHooks()
        hooks.register { error("gone") }
        val removable = hooks.register { calls += "renew" }

        hooks.renewAll()
        removable.close()
        hooks.renewAll()

        assertEquals(listOf("renew"), calls)
    }
}
