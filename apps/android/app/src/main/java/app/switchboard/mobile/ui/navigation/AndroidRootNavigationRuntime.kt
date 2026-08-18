package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.data.connection.ConnectionFleet
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.ReadyClientRegistry
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.data.remote.RoomBrowseSnapshotStore
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.runtime.DurableComposerRuntime
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

class AndroidRootNavigationRuntime(
    private val fleet: ConnectionFleet,
    private val clients: ReadyClientRegistry,
    private val outbox: OutboxRuntime,
    private val composer: DurableComposerRuntime,
    private val protocolEvents: ProtocolEventHub,
    private val removeConnection: (String) -> Unit,
    private val activity: (TransportScope) -> StateFlow<Map<String, BrowseThreadActivity>>,
    private val persistCollapsedWorkspaceIds: (String, Set<String>) -> Unit,
    private val snapshots: RoomBrowseSnapshotStore,
) : RootNavigationRuntime {
    override val statuses: StateFlow<Map<String, ConnectionRuntimeState>> = fleet.statuses
    override val composerDrafts = composer.drafts
    override val composerErrors = composer.errors
    override val queuedTurns: StateFlow<List<QueuedTurn>> = composer.queuedTurns

    override fun lease(connectionId: String): ReadyClientLease? = clients.lease(connectionId)

    override fun connect(connectionId: String) = fleet.connect(connectionId)

    override fun disconnect(connectionId: String) = fleet.disconnect(connectionId)

    override fun retry(connectionId: String) = fleet.retry(connectionId)

    override fun remove(connectionId: String) {
        removeConnection(connectionId)
    }

    override fun enqueue(draft: OutgoingTurnDraft): EnqueueResult = outbox.enqueue(draft)

    override fun replaceQueued(origin: String, draft: OutgoingTurnDraft): EnqueueResult =
        outbox.replace(origin, draft)

    override fun saveComposerDraft(draft: ComposerDraft) = composer.save(draft)

    override fun addComposerImages(key: ComposerDraftKey, sources: List<ComposerImageSource>) =
        composer.addImages(key, sources)

    override fun removeComposerImage(key: ComposerDraftKey, attachmentId: String) =
        composer.removeImage(key, attachmentId)

    override fun clearComposerDraftBlocking(key: ComposerDraftKey): Boolean =
        composer.clearBlocking(key)

    override fun submitSavedComposerDraft(key: ComposerDraftKey) = composer.submitSavedDraft(key)

    override fun beginQueuedEdit(key: ComposerDraftKey, origin: String) = composer.beginEdit(key, origin)

    override fun retryQueued(origin: String) = composer.retry(origin)

    override fun dismissQueued(origin: String) = composer.dismiss(origin)

    override fun eventsFor(scope: TransportScope): Flow<ProtocolHubEvent> =
        protocolEvents.eventsFor(scope)

    override fun browseActivity(scope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> =
        activity(scope)

    override fun saveCollapsedWorkspaceIds(connectionId: String, workspaceIds: Set<String>) {
        persistCollapsedWorkspaceIds(connectionId, workspaceIds)
    }

    override fun browseSnapshotStore(snapshot: OfflineSnapshot): BrowseSnapshotStore =
        snapshots.apply { seed(snapshot.browseSnapshots) }
}
