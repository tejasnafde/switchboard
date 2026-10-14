package app.switchboard.mobile.ui.navigation

import android.util.Log
import app.switchboard.mobile.data.remote.PhoneDemoFixture
import app.switchboard.mobile.data.remote.PhoneDemoRpc
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.OutboxIdentity
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendReceipt
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.ExecutorTransportScheduler
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import app.switchboard.mobile.ui.browse.BrowseThreadActivityIndex
import app.switchboard.mobile.ui.connections.ConnectionItem
import app.switchboard.mobile.ui.connections.ConnectionKind
import app.switchboard.mobile.ui.connections.ConnectionTarget
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The navigation runtime for one demo session. It answers from [PhoneDemoRpc]
 * and keeps everything in memory: no fleet entry, no socket, no Room row, no
 * outbox row, no push registration. Every write the real runtime persists
 * (drafts, thread snapshots, browse caches, filters, preferences) is either
 * held here or dropped, so leaving the demo leaves nothing behind.
 */
class PhoneDemoNavigationRuntime(
    val fixture: PhoneDemoFixture,
    generation: Long,
    private val scheduler: TransportScheduler,
    private val closeScheduler: () -> Unit = {},
    nowMs: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = { Log.w(TAG, it) },
) : RootNavigationRuntime, Closeable {
    val connectionId: String = fixture.connectionId
    val connectionLabel: String = fixture.connectionLabel
    private val transportScope = TransportScope(DEMO_DEVICE_ID, connectionId, generation)
    val rpc = PhoneDemoRpc(fixture, scheduler, transportScope, nowMs, log = { log(it) })
    private val hub = ProtocolEventHub(bufferCapacity = EVENT_BUFFER)
    private val activity = BrowseThreadActivityIndex()
    private val readyLease = ReadyClientLease(
        scope = transportScope,
        capabilities = setOf("pending_requests_v1"),
        client = SwitchboardRemoteClient(connectionId, rpc),
    )
    private val drafts = MutableStateFlow<Map<ComposerDraftKey, ComposerDraft>>(emptyMap())
    @Volatile private var closed = false
    private val subscription: Cancelable = rpc.onRuntimeEvent { scope, event ->
        activity.onEvent(scope, event)
        hub.onRuntimeEvent(scope, event)
    }

    override val statuses: StateFlow<Map<String, ConnectionRuntimeState>> = MutableStateFlow(
        mapOf(connectionId to ConnectionRuntimeState(generation, ConnectionStatus.Connected, "")),
    )
    override val composerDrafts: StateFlow<Map<ComposerDraftKey, ComposerDraft>> = drafts.asStateFlow()

    /** The one machine the demo lists. Its target is a label: there is no address to dial. */
    val connections: ConnectionsLoadState = ConnectionsLoadState.Ready(
        listOf(
            ConnectionItem(
                id = connectionId,
                label = connectionLabel,
                kind = ConnectionKind.WEBSOCKET,
                target = ConnectionTarget.WebSocket(DEMO_TARGET),
                status = app.switchboard.mobile.ui.connections.ConnectionStatus.LIVE,
            ),
        ),
    )

    override fun lease(connectionId: String): ReadyClientLease? =
        readyLease.takeIf { !closed && connectionId == this.connectionId }

    // The demo machine is always connected; there is nothing to dial or forget.
    override fun connect(connectionId: String) = Unit

    override fun disconnect(connectionId: String) = Unit

    override fun retry(connectionId: String) = Unit

    override fun remove(connectionId: String) = Unit

    /** A send goes straight to the demo backend; the demo keeps no outbox. */
    override fun enqueue(draft: OutgoingTurnDraft): EnqueueResult {
        if (closed || draft.connectionId != connectionId) return EnqueueResult.StorageFailure(PhoneDemoRpc.ENDED)
        if (draft.attachments.isNotEmpty()) return EnqueueResult.AttachmentFailure(PhoneDemoRpc.NOT_IN_DEMO)
        val identity = OutboxIdentity("demo-${UUID.randomUUID()}")
        val turn = QueuedTurn(
            connectionId = draft.connectionId,
            threadId = draft.threadId,
            origin = identity.origin,
            bubbleId = identity.bubbleId,
            text = draft.text,
            attachments = emptyList(),
            runtimeMode = draft.runtimeMode,
            createdAtMs = draft.createdAtMs,
            attempts = 1,
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Acknowledged(SendReceipt.legacy()),
            delivery = draft.delivery,
            reviewPill = draft.reviewPill,
        )
        readyLease.client.submitUserTurn(
            threadId = draft.threadId,
            origin = identity.origin,
            providerText = draft.text,
            runtimeMode = RuntimeMode.entries.firstOrNull { it.wire == draft.runtimeMode },
            images = null,
            delivery = draft.delivery,
            callback = { response ->
                (response.outcome as? RemoteOutcome.Failure)?.let { log("demo send failed: ${it.message}") }
            },
        )
        return EnqueueResult.Durable(turn)
    }

    override fun replaceQueued(origin: String, draft: OutgoingTurnDraft): EnqueueResult = enqueue(draft)

    override fun saveComposerDraft(draft: ComposerDraft) {
        drafts.value = drafts.value + (draft.key to draft)
    }

    override fun clearComposerDraftBlocking(key: ComposerDraftKey): Boolean {
        drafts.value = drafts.value - key
        return true
    }

    override fun submitComposerText(key: ComposerDraftKey, text: String, runtimeMode: String?) {
        enqueue(
            OutgoingTurnDraft(
                connectionId = key.connectionId,
                threadId = key.threadId,
                text = text,
                attachments = emptyList(),
                runtimeMode = runtimeMode,
                createdAtMs = System.currentTimeMillis(),
            ),
        )
    }

    override fun observeProtocolEvents(scope: TransportScope, listener: (ProtocolHubEvent) -> Unit): Cancelable =
        hub.observe { if (it.scope == scope) listener(it) }

    override fun eventsFor(scope: TransportScope): Flow<ProtocolHubEvent> = hub.eventsFor(scope)

    override fun browseActivity(scope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> =
        activity.state(scope)

    override fun seedPendingRequests(scope: TransportScope, threadId: String, pending: List<JsonObject>) =
        activity.seedPending(scope, threadId, pending)

    override fun close() {
        if (closed) return
        closed = true
        subscription.cancel()
        rpc.close()
        hub.close()
        closeScheduler()
    }

    companion object {
        /** `connection.id` in the fixture, and `DEMO_CONNECTION_ID` in phone-demo.ts. */
        const val CONNECTION_ID = "demo"
        const val DEMO_DEVICE_ID = "phone-demo"
        const val DEMO_TARGET = "Sample data on this phone"
        private const val EVENT_BUFFER = 256
        private const val TAG = "PhoneDemo"
    }
}

/**
 * Holds the demo session for the process, so it survives an Activity being
 * recreated and ends only on Leave demo. Only memory: a restart has no demo.
 */
class PhoneDemoController(
    private val readFixture: () -> String,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val newScheduler: () -> Pair<TransportScheduler, () -> Unit> = {
        ExecutorTransportScheduler().let { it to it::close }
    },
    private val log: (String, Throwable?) -> Unit = { message, error -> Log.w(TAG, message, error) },
) {
    private val mutableActive = MutableStateFlow<PhoneDemoNavigationRuntime?>(null)
    val active: StateFlow<PhoneDemoNavigationRuntime?> = mutableActive.asStateFlow()

    /** Starts the demo, or returns the one already running. Null when the fixture cannot be read. */
    @Synchronized
    fun start(): PhoneDemoNavigationRuntime? {
        mutableActive.value?.let { return it }
        val fixture = try {
            PhoneDemoFixture.parse(readFixture(), nowMs())
        } catch (error: Exception) {
            log("the demo fixture could not be read", error)
            return null
        }
        val (scheduler, closeScheduler) = newScheduler()
        return PhoneDemoNavigationRuntime(
            fixture = fixture,
            generation = generations.incrementAndGet(),
            scheduler = scheduler,
            closeScheduler = closeScheduler,
            nowMs = nowMs,
        ).also { mutableActive.value = it }
    }

    /** Ends the demo and drops all its state. */
    @Synchronized
    fun leave() {
        val runtime = mutableActive.value ?: return
        mutableActive.value = null
        runtime.close()
    }

    private companion object {
        const val TAG = "PhoneDemo"

        /** A fresh generation per session, so no screen reuses a coordinator from the last one. */
        val generations = AtomicLong(0)
    }
}
