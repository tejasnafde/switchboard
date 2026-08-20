package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.data.remote.EmptyBrowseSnapshotStore
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.thread.ThreadSessionRemote
import app.switchboard.mobile.data.thread.ThreadSnapshotStore
import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.data.thread.NoOpThreadSnapshotStore
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.RuntimeEventPayload
import app.switchboard.mobile.ui.browse.BrowseCollapsePreferences
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import java.io.Closeable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

private val EmptyBrowseActivity = MutableStateFlow<Map<String, BrowseThreadActivity>>(emptyMap())
private val EmptyComposerDrafts = MutableStateFlow<Map<ComposerDraftKey, ComposerDraft>>(emptyMap())
private val EmptyComposerErrors = MutableStateFlow<Map<ComposerDraftKey, String>>(emptyMap())
private val EmptyQueuedTurns = MutableStateFlow<List<QueuedTurn>>(emptyList())

interface RootNavigationRuntime {
    val statuses: StateFlow<Map<String, ConnectionRuntimeState>>
    val composerDrafts: StateFlow<Map<ComposerDraftKey, ComposerDraft>>
        get() = EmptyComposerDrafts
    val composerErrors: StateFlow<Map<ComposerDraftKey, String>>
        get() = EmptyComposerErrors
    val queuedTurns: StateFlow<List<QueuedTurn>>
        get() = EmptyQueuedTurns
    val threadSnapshots: ThreadSnapshotStore
        get() = NoOpThreadSnapshotStore

    fun lease(connectionId: String): ReadyClientLease?

    fun connect(connectionId: String)

    fun disconnect(connectionId: String)

    fun retry(connectionId: String)

    fun remove(connectionId: String)

    fun enqueue(draft: OutgoingTurnDraft): EnqueueResult

    fun replaceQueued(origin: String, draft: OutgoingTurnDraft): EnqueueResult = enqueue(draft)

    fun saveComposerDraft(draft: ComposerDraft) = Unit

    fun addComposerImages(key: ComposerDraftKey, sources: List<ComposerImageSource>) = Unit

    fun removeComposerImage(key: ComposerDraftKey, attachmentId: String) = Unit

    fun clearComposerDraftBlocking(key: ComposerDraftKey): Boolean = true

    fun submitSavedComposerDraft(key: ComposerDraftKey) = Unit

    fun beginQueuedEdit(key: ComposerDraftKey, origin: String) = Unit

    fun retryQueued(origin: String) = Unit

    fun dismissQueued(origin: String) = Unit

    fun eventsFor(scope: TransportScope): Flow<ProtocolHubEvent>

    fun browseActivity(scope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> =
        EmptyBrowseActivity

    fun collapsedWorkspaceIds(connectionId: String, snapshot: OfflineSnapshot): Set<String> =
        BrowseCollapsePreferences.initial(snapshot, connectionId)

    fun saveCollapsedWorkspaceIds(connectionId: String, workspaceIds: Set<String>) = Unit

    fun browseSnapshotStore(snapshot: OfflineSnapshot): BrowseSnapshotStore = EmptyBrowseSnapshotStore

    fun cachedThread(connectionId: String, threadId: String): ThreadState? =
        threadSnapshots.get(connectionId, threadId)

    fun beginViewing(scope: TransportScope, threadId: String): Closeable = Closeable {}

    fun registerViewingLeaseRenewal(callback: () -> Unit): Closeable = Closeable {}
}

sealed interface LeaseFallback {
    data object Loading : LeaseFallback

    data class Retryable(val message: String) : LeaseFallback
}

object RootNavigationPolicy {
    fun fallback(status: ConnectionRuntimeState?): LeaseFallback = when (status?.status) {
        ConnectionStatus.Connecting,
        ConnectionStatus.Connected,
        -> LeaseFallback.Loading

        ConnectionStatus.Error -> LeaseFallback.Retryable(
            status.detail.takeIf(String::isNotBlank) ?: "Machine connection failed",
        )

        ConnectionStatus.Disconnected,
        null,
        -> LeaseFallback.Retryable("Machine is offline")
    }
}

class ProtocolRuntimeEventBridge(
    private val scope: CoroutineScope,
    private val expectedScope: TransportScope,
    private val events: Flow<ProtocolHubEvent>,
    private val isLeaseCurrent: () -> Boolean,
) {
    fun subscribe(listener: (ThreadEventScope, RuntimeEventPayload) -> Unit): Cancelable {
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event ->
                if (
                    event is ProtocolHubEvent.Runtime &&
                    event.scope == expectedScope &&
                    isLeaseCurrent()
                ) {
                    listener(expectedScope.toThreadEventScope(), event.event)
                }
            }
        }
        return Cancelable(job::cancel)
    }
}

fun TransportScope.toThreadEventScope(): ThreadEventScope =
    ThreadEventScope(connectionId, generation)

class ProtocolHubThreadSessionRemote(
    commands: ThreadSessionRemote,
    private val bridge: ProtocolRuntimeEventBridge,
) : ThreadSessionRemote by commands {
    override fun subscribe(
        listener: (ThreadEventScope, RuntimeEventPayload) -> Unit,
    ): Cancelable = bridge.subscribe(listener)
}
