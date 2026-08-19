package app.switchboard.mobile.ui.connections

import java.io.Serializable

enum class ConnectionKind : Serializable {
    WEBSOCKET,
    IAP,
}

sealed interface ConnectionTarget : Serializable {
    data class WebSocket(val url: String) : ConnectionTarget

    data class Iap(
        val instance: String,
        val zone: String,
    ) : ConnectionTarget
}

enum class ConnectionStatus : Serializable {
    LIVE,
    CONNECTING,
    OFFLINE,
    ERROR,
}

data class ConnectionItem(
    val id: String,
    val label: String,
    val kind: ConnectionKind,
    val target: ConnectionTarget,
    val status: ConnectionStatus,
    val detail: String? = null,
) : Serializable

sealed interface ConnectionsLoadState : Serializable {
    data object Loading : ConnectionsLoadState

    data class Ready(
        val connections: List<ConnectionItem>,
        val isRefreshing: Boolean = false,
        val recoveryMessage: String? = null,
    ) : ConnectionsLoadState

    data class Failed(val message: String) : ConnectionsLoadState
}

data class ConnectionRowPresentation(
    val id: String,
    val label: String,
    val kind: ConnectionKind,
    val target: String,
    val status: ConnectionStatus,
    val statusLabel: String,
    val live: Boolean,
    val showProgress: Boolean,
    val detail: String?,
) : Serializable

sealed interface ConnectionsPresentation : Serializable {
    data object Loading : ConnectionsPresentation

    data object Empty : ConnectionsPresentation

    data class Failure(val message: String) : ConnectionsPresentation

    data class Content(
        val summary: String,
        val rows: List<ConnectionRowPresentation>,
        val recoveryMessage: String? = null,
    ) : ConnectionsPresentation
}

enum class ConnectionActionKind : Serializable {
    EDIT,
    CONNECT,
    DISCONNECT,
    REMOVE,
    CANCEL,
}

enum class ConnectionActionStyle : Serializable {
    DEFAULT,
    DESTRUCTIVE,
    CANCEL,
}

data class ConnectionAction(
    val kind: ConnectionActionKind,
    val label: String,
    val style: ConnectionActionStyle = ConnectionActionStyle.DEFAULT,
) : Serializable

sealed interface ConnectionIntent : Serializable {
    data class Open(val connectionId: String) : ConnectionIntent
    data class Connect(val connectionId: String) : ConnectionIntent
    data class Disconnect(val connectionId: String) : ConnectionIntent
    data class Remove(val connectionId: String) : ConnectionIntent
    data object Retry : ConnectionIntent
}

object ConnectionsPresenter {
    fun present(state: ConnectionsLoadState): ConnectionsPresentation = when (state) {
        ConnectionsLoadState.Loading -> ConnectionsPresentation.Loading
        is ConnectionsLoadState.Failed -> ConnectionsPresentation.Failure(state.message)
        is ConnectionsLoadState.Ready -> {
            if (state.connections.isEmpty()) {
                ConnectionsPresentation.Empty
            } else {
                val liveCount = state.connections.count { it.status == ConnectionStatus.LIVE }
                ConnectionsPresentation.Content(
                    summary = if (state.isRefreshing) {
                        "connecting"
                    } else {
                        "$liveCount of ${state.connections.size} live"
                    },
                    rows = state.connections.map(::row),
                    recoveryMessage = state.recoveryMessage,
                )
            }
        }
    }

    fun row(item: ConnectionItem): ConnectionRowPresentation {
        val live = item.status == ConnectionStatus.LIVE
        return ConnectionRowPresentation(
            id = item.id,
            label = item.label,
            kind = item.kind,
            target = when (val target = item.target) {
                is ConnectionTarget.WebSocket -> target.url.removeWebSocketScheme()
                is ConnectionTarget.Iap -> "${target.instance}  ${target.zone}"
            },
            status = item.status,
            statusLabel = when (item.status) {
                ConnectionStatus.LIVE -> "live"
                ConnectionStatus.CONNECTING -> "connecting"
                ConnectionStatus.OFFLINE -> "offline"
                ConnectionStatus.ERROR -> "error"
            },
            live = live,
            showProgress = item.status == ConnectionStatus.CONNECTING,
            detail = item.detail.takeUnless { live },
        )
    }

    fun actions(item: ConnectionItem): List<ConnectionAction> = actions(item.status)

    fun actions(status: ConnectionStatus): List<ConnectionAction> {
        val connectionAction = when (status) {
            ConnectionStatus.LIVE,
            ConnectionStatus.CONNECTING,
            -> ConnectionAction(ConnectionActionKind.DISCONNECT, "Disconnect")

            ConnectionStatus.OFFLINE,
            ConnectionStatus.ERROR,
            -> ConnectionAction(ConnectionActionKind.CONNECT, "Connect")
        }
        return listOf(
            ConnectionAction(ConnectionActionKind.EDIT, "Edit"),
            connectionAction,
            ConnectionAction(
                ConnectionActionKind.REMOVE,
                "Remove",
                ConnectionActionStyle.DESTRUCTIVE,
            ),
            ConnectionAction(
                ConnectionActionKind.CANCEL,
                "Cancel",
                ConnectionActionStyle.CANCEL,
            ),
        )
    }

    private fun String.removeWebSocketScheme(): String =
        removePrefix("ws://").removePrefix("wss://")
}

object ConnectionRowPolicy {
    fun statusLabel(status: ConnectionStatus): String = when (status) {
        ConnectionStatus.LIVE -> "Live"
        ConnectionStatus.CONNECTING -> "Connecting"
        ConnectionStatus.OFFLINE -> "Offline"
        ConnectionStatus.ERROR -> "Error"
    }

    fun supportingText(row: ConnectionRowPresentation): String = listOfNotNull(
        row.target,
        row.detail?.trim()?.takeIf(String::isNotEmpty),
    ).joinToString(" · ")
}
