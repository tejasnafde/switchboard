package app.switchboard.mobile.ui.settings

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdatePresentation
import app.switchboard.mobile.update.UpdateState

data class SettingsPresentation(
    val accountDetail: String,
    val machinesDetail: String,
    val versionDetail: String,
    val update: SettingsUpdateRow,
)

data class SettingsUpdateRow(
    val detail: String,
    val action: UpdateAction?,
    val actionLabel: String?,
    val busy: Boolean,
)

object SettingsPresenter {
    fun present(
        account: GoogleAccountPresentation,
        connections: ConnectionsLoadState,
        updateState: UpdateState,
        versionName: String,
        updatesEnabled: Boolean,
    ) = SettingsPresentation(
        accountDetail = when (account) {
            GoogleAccountPresentation.SignedOut -> "Not connected"
            GoogleAccountPresentation.Blocked -> "Credentials need attention"
            is GoogleAccountPresentation.SignedIn -> account.email?.takeIf(String::isNotBlank)
                ?: "Connected"
        },
        machinesDetail = machineDetail(connections),
        versionDetail = "Version $versionName",
        update = updateRow(updateState, versionName, updatesEnabled),
    )

    fun updateRow(
        state: UpdateState,
        versionName: String,
        enabled: Boolean,
    ): SettingsUpdateRow {
        if (!enabled) {
            return SettingsUpdateRow(
                detail = "Updates are available in production builds",
                action = null,
                actionLabel = null,
                busy = false,
            )
        }
        if (state == UpdateState.Idle) {
            return SettingsUpdateRow(
                detail = "Installed · $versionName",
                action = UpdateAction.CHECK,
                actionLabel = "Check",
                busy = false,
            )
        }
        if (state == UpdateState.UpToDate) {
            return SettingsUpdateRow(
                detail = "Up to date · $versionName",
                action = UpdateAction.CHECK,
                actionLabel = "Check again",
                busy = false,
            )
        }
        if (state == UpdateState.Checking) {
            return SettingsUpdateRow(
                detail = "Checking for updates…",
                action = null,
                actionLabel = null,
                busy = true,
            )
        }
        if (state is UpdateState.Error) {
            return SettingsUpdateRow(
                detail = state.message,
                action = UpdateAction.RETRY,
                actionLabel = "Retry",
                busy = false,
            )
        }
        val update = UpdatePresentation.from(state)
        return SettingsUpdateRow(
            detail = listOf(update.title, update.detail)
                .filter(String::isNotBlank)
                .distinct()
                .joinToString(" · "),
            action = update.primaryAction,
            actionLabel = update.primaryAction?.settingsLabel,
            busy = update.busy,
        )
    }

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

private val UpdateAction.settingsLabel: String
    get() = when (this) {
        UpdateAction.CHECK -> "Check"
        UpdateAction.DOWNLOAD -> "Download"
        UpdateAction.CANCEL -> "Cancel"
        UpdateAction.INSTALL -> "Install"
        UpdateAction.OPEN_SETTINGS -> "Open Android settings"
        UpdateAction.RETRY -> "Retry"
    }
