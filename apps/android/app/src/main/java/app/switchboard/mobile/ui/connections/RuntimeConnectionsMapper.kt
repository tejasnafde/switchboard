package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus as RuntimeStatus
import app.switchboard.mobile.platform.startup.StartupRuntimeState

object RuntimeConnectionsMapper {
    fun map(
        startup: StartupRuntimeState,
        runtime: Map<String, ConnectionRuntimeState>,
    ): ConnectionsLoadState = overlay(StartupConnectionsMapper.map(startup), runtime)

    fun overlay(
        stored: ConnectionsLoadState,
        runtime: Map<String, ConnectionRuntimeState>,
    ): ConnectionsLoadState {
        if (stored !is ConnectionsLoadState.Ready) return stored
        return stored.copy(
            connections = stored.connections.map { item ->
                val live = runtime[item.id] ?: return@map item
                item.copy(
                    status = when (live.status) {
                        RuntimeStatus.Disconnected -> ConnectionStatus.OFFLINE
                        RuntimeStatus.Connecting -> ConnectionStatus.CONNECTING
                        RuntimeStatus.Connected -> ConnectionStatus.LIVE
                        RuntimeStatus.Error -> ConnectionStatus.ERROR
                    },
                    detail = live.detail.takeIf(String::isNotBlank),
                )
            },
        )
    }
}
