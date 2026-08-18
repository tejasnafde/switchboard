package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.startup.StartupRecovery
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import org.junit.Assert.assertEquals
import org.junit.Test

class StartupConnectionsMapperTest {
    @Test
    fun `startup loading and blockers remain visible`() {
        assertEquals(
            ConnectionsLoadState.Loading,
            StartupConnectionsMapper.map(StartupRuntimeState.Loading),
        )
        assertEquals(
            ConnectionsLoadState.Failed("legacy WAL unavailable"),
            StartupConnectionsMapper.map(
                StartupRuntimeState.Blocked(
                    StartupRecovery(
                        stage = StartupRecovery.Stage.MIGRATION,
                        detail = "legacy WAL unavailable",
                    ),
                ),
            ),
        )
    }

    @Test
    fun `offline snapshot presents every migrated connection without dialing`() {
        val state = StartupRuntimeState.Ready(
            offlineSnapshot = snapshot(
                listOf(
                    ConnectionEntity("lan", "Studio", "ws", "ws://192.168.1.8:8765", null, null, null, null),
                    ConnectionEntity("work", "Work", "iap", null, "project", "asia-south1-b", "vm-1", 8766),
                ),
            ),
            retirementCandidates = emptyList(),
        )

        val ready = StartupConnectionsMapper.map(state) as ConnectionsLoadState.Ready

        assertEquals(2, ready.connections.size)
        assertEquals(ConnectionTarget.WebSocket("ws://192.168.1.8:8765"), ready.connections[0].target)
        assertEquals(ConnectionStatus.OFFLINE, ready.connections[0].status)
        assertEquals(ConnectionTarget.Iap("vm-1", "asia-south1-b"), ready.connections[1].target)
        assertEquals(ConnectionStatus.OFFLINE, ready.connections[1].status)
    }

    @Test
    fun `invalid native rows fail visibly instead of disappearing`() {
        val state = StartupRuntimeState.Ready(
            offlineSnapshot = snapshot(
                listOf(ConnectionEntity("broken", "Broken", "ws", null, null, null, null, null)),
            ),
            retirementCandidates = emptyList(),
        )

        assertEquals(
            ConnectionsLoadState.Failed("Stored machine broken is missing its WebSocket address"),
            StartupConnectionsMapper.map(state),
        )
    }

    private fun snapshot(connections: List<ConnectionEntity>) = OfflineSnapshot(
        connections = connections,
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
