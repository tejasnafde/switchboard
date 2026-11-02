package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.remote.BrowseCoordinator
import app.switchboard.mobile.data.remote.BrowseRemote
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.platform.log.SbLog
import app.switchboard.mobile.platform.protocol.Cancelable
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
    /** `SwitchboardRemoteClient.onConversationSettled`: a chat settled on any client re-reads the list. */
    private val onConversationSettled: (listener: () -> Unit) -> Cancelable = { Cancelable {} },
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
    private var settledSubscription: Cancelable? = null

    fun start() {
        SbLog.i("home", "$connectionId gen=$expectedGeneration refresh projects")
        // Listen first: a settle while the first read is out supersedes that read.
        settledSubscription?.cancel()
        settledSubscription = onConversationSettled {
            SbLog.i("home", "$connectionId gen=$expectedGeneration a chat settled, refresh projects")
            browse.refreshProjectIndex()
        }
        browse.refreshProjectIndex()
    }

    override fun close() {
        settledSubscription?.cancel()
        settledSubscription = null
        browse.close()
    }
}
