package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.remote.BrowseCoordinator
import app.switchboard.mobile.data.remote.BrowseRemote
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.ui.browse.BrowseState
import java.io.Closeable
import kotlinx.coroutines.flow.StateFlow

class HomeProjectRefreshCoordinator(
    connectionId: String,
    connectionLabel: String,
    offlineSnapshot: OfflineSnapshot,
    remote: BrowseRemote,
    expectedGeneration: Long,
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

    fun start() = browse.refreshProjectIndex()

    override fun close() = browse.close()
}
