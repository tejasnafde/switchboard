package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.data.composer.ComposerFileUploader
import app.switchboard.mobile.data.connection.ConnectionFleet
import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.thread.WithdrawnTurn
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.ReadyClientRegistry
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.data.remote.RoomBrowseSnapshotStore
import app.switchboard.mobile.data.remote.NewSessionWorktreeCreationStore
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.thread.ThreadSnapshotStore
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.iap.IapDiscoveredTarget
import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.domain.iap.IapTargetDiscovery
import app.switchboard.mobile.domain.iap.IapTargetSelection
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.runtime.DurableComposerRuntime
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import app.switchboard.mobile.domain.reviews.PhonePrFilters
import app.switchboard.mobile.domain.reviews.PhonePullRequests
import java.io.Closeable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import app.switchboard.mobile.domain.thread.TurnDelivery
import kotlin.coroutines.resume
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine

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
    override val threadSnapshots: ThreadSnapshotStore,
    override val worktreeCreations: NewSessionWorktreeCreationStore,
    private val beginViewingLease: (TransportScope, String) -> Closeable = { _, _ -> Closeable {} },
    private val registerViewingRenewal: (() -> Unit) -> Closeable = { Closeable {} },
    override val followUpDefault: StateFlow<TurnDelivery> = MutableStateFlow(TurnDelivery.Steer),
    private val persistFollowUpDefault: (TurnDelivery) -> Unit = {},
    private val seedPending: (TransportScope, String, List<JsonObject>) -> Unit = { _, _, _ -> },
    private val refreshStatuses: (ReadyClientLease) -> Unit = {},
    private val persistPreference: (String, String) -> Unit = { _, _ -> },
) : RootNavigationRuntime {
    /** Saved this session; the offline snapshot is read once at startup and can lag. */
    private val savedReviewFilters = java.util.concurrent.ConcurrentHashMap<String, PhonePrFilters>()

    override fun reviewFilters(connectionId: String, snapshot: OfflineSnapshot): PhonePrFilters =
        savedReviewFilters[connectionId] ?: super.reviewFilters(connectionId, snapshot)

    override fun saveReviewFilters(connectionId: String, filters: PhonePrFilters) {
        savedReviewFilters[connectionId] = filters
        persistPreference(PhonePullRequests.filtersKey(connectionId), PhonePullRequests.encodeFilters(filters))
    }

    override fun refreshLiveStatuses(lease: ReadyClientLease) = refreshStatuses(lease)

    override fun seedPendingRequests(scope: TransportScope, threadId: String, pending: List<JsonObject>) =
        seedPending(scope, threadId, pending)

    override fun setFollowUpDefault(value: TurnDelivery) = persistFollowUpDefault(value)

    override val statuses: StateFlow<Map<String, ConnectionRuntimeState>> = fleet.statuses
    override val composerDrafts = composer.drafts
    override val composerErrors = composer.errors
    override val composerUploads = composer.uploads
    override val queuedTurns: StateFlow<List<QueuedTurn>> = composer.queuedTurns

    override fun lease(connectionId: String): ReadyClientLease? = clients.lease(connectionId)

    override suspend fun discoverIapTargets(
        connectionIds: List<String>,
        saved: List<IapTarget>,
    ): IapTargetSelection = coroutineScope {
        val sources = connectionIds
            .distinct()
            .mapNotNull(clients::lease)
            .map { lease -> async { lease.discoverIapTargets() } }
            .awaitAll()
        IapTargetDiscovery.select(sources, saved)
    }

    override fun connect(connectionId: String) = fleet.connect(connectionId)

    override fun disconnect(connectionId: String) = fleet.disconnect(connectionId)

    override fun retry(connectionId: String) = fleet.retry(connectionId)

    override fun remove(connectionId: String) {
        removeConnection(connectionId)
    }

    override fun enqueue(draft: OutgoingTurnDraft): EnqueueResult = outbox.enqueue(draft)

    override fun replaceQueued(origin: String, draft: OutgoingTurnDraft): EnqueueResult =
        outbox.replace(origin, draft)

    override fun holdQueued(connectionId: String, threadId: String, held: Boolean) =
        outbox.holdThread(connectionId, threadId, held)

    override fun withdrawQueued(origin: String, existing: List<ComposerAttachment>): WithdrawnTurn? {
        var restaged: ComposerAttachmentStageResult? = null
        val turn = outbox.withdraw(origin) { turn ->
            if (turn.attachments.isNotEmpty()) restaged = composer.restageImages(turn.attachments, existing)
        } ?: return null
        return when (val result = restaged) {
            null -> WithdrawnTurn(turn)
            is ComposerAttachmentStageResult.Failure ->
                WithdrawnTurn(turn, attachmentError = "Images could not be restored: ${result.reason}")
            is ComposerAttachmentStageResult.Success -> WithdrawnTurn(
                turn,
                attachments = result.attachments,
                attachmentError = result.refused.takeIf { it.isNotEmpty() }?.joinToString("\n"),
            )
        }
    }

    override fun saveComposerDraft(draft: ComposerDraft) = composer.save(draft)

    override fun saveComposerText(draft: ComposerDraft) = composer.saveText(draft)

    override fun addComposerImages(key: ComposerDraftKey, sources: List<ComposerImageSource>, uploader: ComposerFileUploader?) =
        composer.addAttachments(key, sources, uploader)

    override fun attachPastedText(key: ComposerDraftKey, text: String, uploader: ComposerFileUploader, onFailed: (String) -> Unit) =
        composer.attachPastedText(key, text, uploader, onFailed)

    override fun composerUploading(key: ComposerDraftKey): Boolean = composer.uploading(key)

    override fun removeComposerImage(key: ComposerDraftKey, attachmentId: String) =
        composer.removeImage(key, attachmentId)

    override fun clearComposerDraftBlocking(key: ComposerDraftKey): Boolean =
        composer.clearBlocking(key)

    override fun submitSavedComposerDraft(key: ComposerDraftKey) = composer.submitSavedDraft(key)

    override fun submitComposerText(key: ComposerDraftKey, text: String, runtimeMode: String?) =
        composer.submitText(key, text, runtimeMode)

    override fun beginQueuedEdit(key: ComposerDraftKey, origin: String) = composer.beginEdit(key, origin)

    override fun retryQueued(origin: String) = composer.retry(origin)

    override fun abandonQueued(origin: String) {
        val turn = outbox.records().firstOrNull { it.origin == origin } ?: return
        val client = clients.lease(turn.connectionId)?.client ?: return
        client.resolveUserTurn(turn.threadId, turn.origin) { response ->
            val status = ((response.outcome as? RemoteOutcome.Success)?.value?.body as? JsonObject)
                ?.values?.get("status") as? JsonString
            if (status?.value == "abandoned" || status?.value == "completed") {
                outbox.abandonResolved(origin)
            }
        }
    }

    override fun dismissQueued(origin: String) = composer.dismiss(origin)

    override fun observeProtocolEvents(scope: TransportScope, listener: (ProtocolHubEvent) -> Unit): Cancelable =
        protocolEvents.observe { if (it.scope == scope) listener(it) }

    override fun eventsFor(scope: TransportScope): Flow<ProtocolHubEvent> =
        protocolEvents.eventsFor(scope)

    override fun browseActivity(scope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> =
        activity(scope)

    override fun saveCollapsedWorkspaceIds(connectionId: String, workspaceIds: Set<String>) {
        persistCollapsedWorkspaceIds(connectionId, workspaceIds)
    }

    override fun browseSnapshotStore(snapshot: OfflineSnapshot): BrowseSnapshotStore =
        snapshots.apply { seed(snapshot.browseSnapshots) }

    override fun beginViewing(scope: TransportScope, threadId: String): Closeable =
        beginViewingLease(scope, threadId)

    override fun registerViewingLeaseRenewal(callback: () -> Unit): Closeable =
        registerViewingRenewal(callback)
}

private suspend fun ReadyClientLease.discoverIapTargets(): List<IapDiscoveredTarget> =
    suspendCancellableCoroutine { continuation ->
        client.listIapTargets { response ->
            val targets = when (val outcome = response.outcome) {
                is RemoteOutcome.Success -> outcome.value
                is RemoteOutcome.Failure -> emptyList()
            }
            if (continuation.isActive) continuation.resume(targets)
        }
    }
