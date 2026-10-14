package app.switchboard.mobile.ui.settings

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionsLoadState

data class SettingsPresentation(
    val accountDetail: String,
    val machinesDetail: String,
    val versionDetail: String,
)

object SettingsPresenter {
    fun present(
        account: GoogleAccountPresentation,
        connections: ConnectionsLoadState,
        versionName: String,
    ) = SettingsPresentation(
        accountDetail = when (account) {
            GoogleAccountPresentation.SignedOut -> "Not connected"
            GoogleAccountPresentation.Blocked -> "Credentials need attention"
            is GoogleAccountPresentation.SignedIn -> account.email?.takeIf(String::isNotBlank)
                ?: "Connected"
        },
        machinesDetail = machineDetail(connections),
        versionDetail = "Version $versionName",
    )

    private fun machineDetail(state: ConnectionsLoadState): String = when (state) {
        ConnectionsLoadState.Loading -> "Loading…"
        is ConnectionsLoadState.Failed -> "Could not load machines"
        is ConnectionsLoadState.Ready -> when {
            state.connections.isEmpty() -> "No machines paired"
            state.isRefreshing -> "Connecting · ${state.connections.size} paired"
            else -> {
                val live = state.connections.count { it.status == ConnectionStatus.LIVE }
                "$live of ${state.connections.size} live"
            }
        }
    }
}
