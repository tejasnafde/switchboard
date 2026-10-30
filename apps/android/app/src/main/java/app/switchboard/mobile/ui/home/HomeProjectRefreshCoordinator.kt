package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.remote.BrowseCoordinator
import app.switchboard.mobile.data.remote.BrowseRemote
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.platform.log.SbLog
import app.switchboard.mobile.ui.browse.BrowseState
import java.io.Closeable
import kotlinx.coroutines.flow.StateFlow

class HomeProjectRefreshCoordinator(
    private val connectionId: String,
    connectionLabel: String,
    offlineSnapshot: OfflineSnapshot,
    remote: BrowseRemote,
    private val expectedGeneration: Long,
    snapshotStore: BrowseSnapshotStore,
) : Closeable {
    private val browse = BrowseCoordinator(
        connectionId = connectionId,
        connectionLabel = connectionLabel,
        offlineSnapshot = offlineSnapshot,
        remote = remote,
        expectedGeneration = expectedGeneration,
        snapshotStore = snapshotStore,
    )

    val state: StateFlow<BrowseState> = browse.state

    fun start() {
        SbLog.i("home", "$connectionId gen=$expectedGeneration refresh projects")
        browse.refreshProjectIndex()
    }

    override fun close() = browse.close()
}
