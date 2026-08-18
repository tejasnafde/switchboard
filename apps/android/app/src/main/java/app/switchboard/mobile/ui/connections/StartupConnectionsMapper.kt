package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.platform.startup.StartupRuntimeState

object StartupConnectionsMapper {
    fun map(state: StartupRuntimeState): ConnectionsLoadState = when (state) {
        StartupRuntimeState.Loading -> ConnectionsLoadState.Loading
        is StartupRuntimeState.Blocked -> ConnectionsLoadState.Failed(state.recovery.detail)
        is StartupRuntimeState.Ready -> runCatching {
            ConnectionsLoadState.Ready(state.offlineSnapshot.connections.map(::connection))
        }.getOrElse { failure ->
            ConnectionsLoadState.Failed(failure.message ?: "Stored machines could not be loaded")
        }
    }

    private fun connection(row: ConnectionEntity): ConnectionItem = when (row.kind) {
        "ws" -> ConnectionItem(
            id = row.id,
            label = row.label,
            kind = ConnectionKind.WEBSOCKET,
            target = ConnectionTarget.WebSocket(
                requireNotNull(row.url) { "Stored machine ${row.id} is missing its WebSocket address" },
            ),
            status = ConnectionStatus.OFFLINE,
        )
        "iap" -> ConnectionItem(
            id = row.id,
            label = row.label,
            kind = ConnectionKind.IAP,
            target = ConnectionTarget.Iap(
                instance = requireNotNull(row.instance) { "Stored machine ${row.id} is missing its IAP instance" },
                zone = requireNotNull(row.zone) { "Stored machine ${row.id} is missing its IAP zone" },
            ),
            status = ConnectionStatus.OFFLINE,
        )
        else -> error("Stored machine ${row.id} has unsupported kind ${row.kind}")
    }
}
