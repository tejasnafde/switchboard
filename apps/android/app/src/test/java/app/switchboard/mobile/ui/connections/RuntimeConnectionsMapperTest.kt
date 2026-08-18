package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus as RuntimeStatus
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import org.junit.Assert.assertEquals
import org.junit.Test

class RuntimeConnectionsMapperTest {
    @Test
    fun overlaysOnlyMatchingRuntimeStatusesWithoutLosingStoredRows() {
        val mapped = RuntimeConnectionsMapper.map(
            startup = ready(ws("a"), ws("b")),
            runtime = mapOf(
                "a" to ConnectionRuntimeState(4, RuntimeStatus.Connected, ""),
                "unknown" to ConnectionRuntimeState(9, RuntimeStatus.Error, "ignored"),
            ),
        ) as ConnectionsLoadState.Ready

        assertEquals(listOf("a", "b"), mapped.connections.map { it.id })
        assertEquals(ConnectionStatus.LIVE, mapped.connections[0].status)
        assertEquals(ConnectionStatus.OFFLINE, mapped.connections[1].status)
    }

    @Test
    fun mapsConnectingAndFailureDetailExactly() {
        val connecting = RuntimeConnectionsMapper.map(
            ready(ws("a")),
            mapOf("a" to ConnectionRuntimeState(2, RuntimeStatus.Connecting, "retry 2")),
        ) as ConnectionsLoadState.Ready
        val failed = RuntimeConnectionsMapper.map(
            ready(ws("a")),
            mapOf("a" to ConnectionRuntimeState(3, RuntimeStatus.Error, "token rejected - re-pair")),
        ) as ConnectionsLoadState.Ready

        assertEquals(ConnectionStatus.CONNECTING, connecting.connections.single().status)
        assertEquals("retry 2", connecting.connections.single().detail)
        assertEquals(ConnectionStatus.ERROR, failed.connections.single().status)
        assertEquals("token rejected - re-pair", failed.connections.single().detail)
    }

    @Test
    fun loadingAndBlockedStartupStatesRemainAuthoritative() {
        assertEquals(
            ConnectionsLoadState.Loading,
            RuntimeConnectionsMapper.map(
                StartupRuntimeState.Loading,
                mapOf("a" to ConnectionRuntimeState(1, RuntimeStatus.Connected, "")),
            ),
        )
    }

    @Test
    fun alreadyMappedStoredStateCanReceiveFleetStatusesAtTheComposeBoundary() {
        val stored = StartupConnectionsMapper.map(ready(ws("a"), ws("b")))

        val mapped = RuntimeConnectionsMapper.overlay(
            stored,
            mapOf("b" to ConnectionRuntimeState(5, RuntimeStatus.Connected, "")),
        ) as ConnectionsLoadState.Ready

        assertEquals(ConnectionStatus.OFFLINE, mapped.connections[0].status)
        assertEquals(ConnectionStatus.LIVE, mapped.connections[1].status)
    }

    private fun ready(vararg rows: ConnectionEntity) = StartupRuntimeState.Ready(
        offlineSnapshot = OfflineSnapshot(
            connections = rows.toList(),
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
        ),
        retirementCandidates = emptyList(),
    )

    private fun ws(id: String) = ConnectionEntity(
        id = id,
        label = id,
        kind = "ws",
        url = "wss://$id",
        project = null,
        zone = null,
        instance = null,
        port = null,
    )
}
