package app.switchboard.mobile.runtime

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.startup.StartupRecovery
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import org.junit.Assert.assertEquals
import org.junit.Test

class ApplicationRuntimeCoordinatorTest {
    @Test
    fun `ready seeds offline state before hydrating durable outbox`() {
        val calls = mutableListOf<String>()
        val coordinator = ApplicationRuntimeCoordinator(
            seedRepository = { calls += "seed" },
            startupOutbox = { calls += "hydrate" },
            wakeOutbox = { calls += "wake" },
        )

        coordinator.onStartupState(StartupRuntimeState.Ready(emptySnapshot(), emptyList()))

        assertEquals(listOf("seed", "hydrate"), calls)
    }

    @Test
    fun `loading and blocked startup never expose storage or release outbox`() {
        val calls = mutableListOf<String>()
        val coordinator = ApplicationRuntimeCoordinator(
            seedRepository = { calls += "seed" },
            startupOutbox = { calls += "hydrate" },
            wakeOutbox = { calls += "wake" },
        )

        coordinator.onStartupState(StartupRuntimeState.Loading)
        coordinator.onStartupState(
            StartupRuntimeState.Blocked(
                StartupRecovery(
                    stage = StartupRecovery.Stage.MIGRATION,
                    detail = "blocked",
                ),
            ),
        )

        assertEquals(emptyList<String>(), calls)
    }

    @Test
    fun `every fleet transition wakes the hydrated outbox path`() {
        val calls = mutableListOf<String>()
        val coordinator = ApplicationRuntimeCoordinator(
            seedRepository = {},
            startupOutbox = {},
            wakeOutbox = { calls += "wake" },
        )

        coordinator.onFleetChanged()
        coordinator.onFleetChanged()

        assertEquals(listOf("wake", "wake"), calls)
    }

    private fun emptySnapshot() = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = emptyList(),
        feedRows = emptyList(),
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}
