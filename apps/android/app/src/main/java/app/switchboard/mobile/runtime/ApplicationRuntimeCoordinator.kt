package app.switchboard.mobile.runtime

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.startup.StartupRuntimeState

class ApplicationRuntimeCoordinator(
    private val seedRepository: (OfflineSnapshot) -> Unit,
    private val startupOutbox: () -> Unit,
    private val wakeOutbox: () -> Unit,
) {
    fun onStartupState(state: StartupRuntimeState) {
        if (state !is StartupRuntimeState.Ready) return
        seedRepository(state.offlineSnapshot)
        startupOutbox()
    }

    fun onFleetChanged() {
        wakeOutbox()
    }
}
