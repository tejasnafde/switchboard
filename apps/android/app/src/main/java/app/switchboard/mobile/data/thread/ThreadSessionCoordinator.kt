package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.remote.AnswerQuestion
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.ArchiveConversationResult
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.remote.ForkLineageMetadata
import app.switchboard.mobile.domain.remote.MarkReadResult
import app.switchboard.mobile.domain.remote.ModelOption
import app.switchboard.mobile.domain.remote.NewSessionDecisions
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchRequest
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchResult
import app.switchboard.mobile.domain.remote.ProviderSkill
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.remote.SessionMeta
import app.switchboard.mobile.domain.remote.StartedSession
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.HostWriteCards
import app.switchboard.mobile.domain.thread.HostWriteResponse
import app.switchboard.mobile.domain.thread.PrLink
import app.switchboard.mobile.domain.thread.PrLinkRef
import app.switchboard.mobile.domain.thread.PrLinkUnlinkResult
import app.switchboard.mobile.domain.thread.QueuedTurnActionResult
import app.switchboard.mobile.domain.thread.QueuedTurnSummary
import app.switchboard.mobile.domain.thread.TurnDelivery
import app.switchboard.mobile.domain.thread.TurnDeliveryPolicy
import app.switchboard.mobile.domain.thread.ThreadEventDecoder
import app.switchboard.mobile.domain.thread.ExpiredRequests
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.domain.thread.ThreadSnapshot
import app.switchboard.mobile.domain.thread.UserMessageVisibility
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

sealed interface ThreadSessionLoad {
    data class Loading(val cached: ThreadState?) : ThreadSessionLoad

    data class Ready(
        val thread: ThreadState,
        val cached: Boolean = false,
        val refreshing: Boolean = false,
        val recoveryMessage: String? = null,
    ) : ThreadSessionLoad

    data class Failed(
        val message: String,
        val cached: ThreadState?,
    ) : ThreadSessionLoad
}

data class ThreadComposerState(
    val draft: String = "",
    val runtimeMode: RuntimeMode = RuntimeMode.Sandbox,
    val submitting: Boolean = false,
    val interrupting: Boolean = false,
    val modeChanging: Boolean = false,
    val error: String? = null,
    val focusRequest: Long = 0,
    val attachments: List<ComposerAttachment> = emptyList(),
    val editingOrigin: String? = null,
    /** The next send does the opposite of the device's follow-up default. */
    val flipNextDelivery: Boolean = false,
)

data class ThreadSessionState(
    val load: ThreadSessionLoad,
    val composer: ThreadComposerState,
    val controlMessage: String? = null,
    val skills: List<ProviderSkill> = emptyList(),
    val models: ThreadModelState = ThreadModelState(),
    val profiles: ThreadProfileState = ThreadProfileState(),
    val archive: ThreadArchiveState = ThreadArchiveState(),
    val pendingActions: ThreadPendingActions = ThreadPendingActions(),
    val forkMetadata: ForkLineageMetadata? = null,
    val followUp: ThreadFollowUpState = ThreadFollowUpState(),
    val prLinks: List<PrLink> = emptyList(),
)

data class ThreadFollowUpState(
    val preferred: TurnDelivery = TurnDelivery.Steer,
    /** Backend holds a `delivery: queue` message (`turn_queue_v1`). */
    val canQueue: Boolean = false,
    /** Backend lists, promotes and cancels held messages (`turn_queue_controls_v1`). */
    val canControlHeld: Boolean = false,
    /** Why the last Send now / Cancel was refused, by held message id. */
    val heldErrors: Map<String, String> = emptyMap(),
    val heldBusy: Set<String> = emptySet(),
)

data class ThreadArchiveState(
    val archiving: Boolean = false,
    val error: String? = null,
)

data class ThreadProfileState(
    val options: List<ProviderInstance> = emptyList(),
    val selectedInstanceId: String? = null,
    val loading: Boolean = false,
    val changing: Boolean = false,
    val switchingTo: String? = null,
    val error: String? = null,
)

data class ThreadModelState(
    val options: List<ModelOption> = emptyList(),
    val selectedModelId: String? = null,
    val loading: Boolean = false,
    val changing: Boolean = false,
    val error: String? = null,
)

data class ThreadPendingActions(
    val approvalDecisions: Map<String, ApprovalDecision> = emptyMap(),
    val questionRequestIds: Set<String> = emptySet(),
    val planIds: Set<String> = emptySet(),
    /** Not delivered rows whose Send is in flight, by stored message id. */
    val undeliveredIds: Set<String> = emptySet(),
    /** The backend takes this device's approval of an agent's pull request write card. */
    val backendTakesPhoneApproval: Boolean = false,
    /** The backend's agent cards wait without a time limit and take a quiet answer. */
    val backendAsyncApproval: Boolean = false,
)

sealed interface ComposerSubmitResult {
    data class Durable(val turn: app.switchboard.mobile.domain.outbox.QueuedTurn) : ComposerSubmitResult
    data class Failed(val message: String) : ComposerSubmitResult
    data object Empty : ComposerSubmitResult
    data object Busy : ComposerSubmitResult
}

enum class ThreadSessionPlanAction {
    Implement,
    Iterate,
}

sealed interface ThreadSessionControl {
    data class Approval(
        val requestId: String,
        val decision: ApprovalDecision,
        val response: HostWriteResponse? = null,
    ) : ThreadSessionControl

    data class AnswerQuestion(
        val requestId: String,
        val answers: List<List<String>>,
    ) : ThreadSessionControl

    data class Plan(
        val planId: String,
        val action: ThreadSessionPlanAction,
    ) : ThreadSessionControl

    data class OpenFile(
        val fileEditId: String,
        val repoRoot: String,
        val relPath: String,
    ) : ThreadSessionControl

    /** Send a message a session link refused, as the user's own send. */
    data class SendUndelivered(
        val messageId: String,
        val targetThreadId: String,
        val text: String,
    ) : ThreadSessionControl
}

sealed interface ThreadControlOutcome {
    data object Requested : ThreadControlOutcome
    data class Durable(val turn: app.switchboard.mobile.domain.outbox.QueuedTurn) : ThreadControlOutcome
    data object ComposerFocused : ThreadControlOutcome
    data object Busy : ThreadControlOutcome
    data class Unsupported(val message: String) : ThreadControlOutcome
    data class Failed(val message: String) : ThreadControlOutcome
}

fun interface ThreadEnqueuePort {
    fun enqueue(draft: OutgoingTurnDraft): EnqueueResult

    fun replace(origin: String, draft: OutgoingTurnDraft): EnqueueResult = enqueue(draft)
}

interface ThreadComposerPersistence {
    fun save(draft: ComposerDraft)

    fun clear(key: ComposerDraftKey): Boolean
}

private object NoOpThreadComposerPersistence : ThreadComposerPersistence {
    override fun save(draft: ComposerDraft) = Unit

    override fun clear(key: ComposerDraftKey): Boolean = true
}

fun interface ThreadSessionClock {
    fun nowMs(): Long
}

interface ThreadSessionRemote {
    val scope: ThreadEventScope

    fun subscribe(listener: (ThreadEventScope, RuntimeEventPayload) -> Unit): Cancelable

    fun subscribeGaps(listener: (ThreadEventScope) -> Unit): Cancelable = Cancelable {}

    fun loadSession(threadId: String, limit: Long, callback: (RemoteResponse<LoadedSession>) -> Unit)

    fun loadSessionWindow(threadId: String, beforeId: String?, callback: (RemoteResponse<LoadedSession>) -> Unit): Unit =
        throw UnsupportedOperationException("History windows are not supported")

    fun startSession(input: StartSession, callback: (RemoteResponse<StartedSession>) -> Unit)

    fun markRead(threadId: String, callback: (RemoteResponse<MarkReadResult>) -> Unit)

    fun listSkills(
        threadId: String,
        callback: (RemoteResponse<List<ProviderSkill>?>) -> Unit,
    )

    fun listModels(
        threadId: String,
        callback: (RemoteResponse<List<ModelOption>?>) -> Unit,
    )

    fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit)

    fun switchInstance(
        threadId: String,
        request: ProviderInstanceSwitchRequest,
        callback: (RemoteResponse<ProviderInstanceSwitchResult>) -> Unit,
    )

    fun archiveConversation(
        threadId: String,
        callback: (RemoteResponse<ArchiveConversationResult>) -> Unit,
    )

    fun respondToRequest(
        threadId: String,
        requestId: String,
        decision: ApprovalDecision,
        response: HostWriteResponse?,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    fun answerQuestion(
        threadId: String,
        requestId: String,
        answers: List<List<String>>,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    fun setRuntimeMode(
        threadId: String,
        mode: RuntimeMode,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    fun setModel(
        threadId: String,
        model: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    fun interrupt(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit)

    fun deliverPeerMessage(
        threadId: String,
        targetThreadId: String,
        text: String,
        undeliveredId: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ): Unit = throw UnsupportedOperationException("Sending a kept peer message is not supported")

    /** A thread's still-open approval/question/plan cards, from the backend's
     *  own bookkeeping rather than a live event a resume gap or a reload may
     *  have dropped for good. Only call when `pending_requests_v1` is
     *  advertised - an older backend has no handler for the channel. */
    fun getPendingRequests(threadId: String, callback: (RemoteResponse<List<JsonObject>>) -> Unit)

    /** Only called on `turn_queue_controls_v1`. */
    fun listQueuedTurns(threadId: String, callback: (RemoteResponse<List<QueuedTurnSummary>>) -> Unit): Unit =
        throw UnsupportedOperationException("Queued messages are not supported")

    /** Send now when [promote], else Cancel. Only called on `turn_queue_controls_v1`. */
    fun actOnQueuedTurn(
        threadId: String,
        messageId: String,
        promote: Boolean,
        callback: (RemoteResponse<QueuedTurnActionResult>) -> Unit,
    ): Unit = throw UnsupportedOperationException("Queued messages are not supported")

    /** The pull requests linked to this chat; open to a phone's scopes, no capability gate. */
    fun pullRequestLinks(threadId: String, callback: (RemoteResponse<List<PrLink>>) -> Unit): Unit =
        throw UnsupportedOperationException("Pull request links are not supported")

    fun unlinkPullRequest(
        threadId: String,
        ref: PrLinkRef,
        callback: (RemoteResponse<PrLinkUnlinkResult>) -> Unit,
    ): Unit = throw UnsupportedOperationException("Pull request links are not supported")

    /** Any chat's links changed; re-read this thread's links rather than matching ids. */
    fun onPullRequestLinksChanged(listener: () -> Unit): Cancelable = Cancelable {}

    /** Start a queue held after a failed or usage-limited turn. */
    fun resumeQueuedTurns(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit): Unit =
        throw UnsupportedOperationException("Queued messages are not supported")
}

class SwitchboardThreadSessionRemote(
    private val client: SwitchboardRemoteClient,
    override val scope: ThreadEventScope,
) : ThreadSessionRemote {
    override fun subscribe(listener: (ThreadEventScope, RuntimeEventPayload) -> Unit): Cancelable =
        client.onProviderEvent { transportScope, event ->
            listener(
                ThreadEventScope(transportScope.connectionId, transportScope.generation),
                event,
            )
        }

    override fun loadSession(threadId: String, limit: Long, callback: (RemoteResponse<LoadedSession>) -> Unit) {
        client.loadSession(threadId, limit, callback)
    }

    override fun loadSessionWindow(threadId: String, beforeId: String?, callback: (RemoteResponse<LoadedSession>) -> Unit) {
        client.loadSessionWindow(threadId, beforeId, callback)
    }

    override fun startSession(input: StartSession, callback: (RemoteResponse<StartedSession>) -> Unit) {
        client.startSession(input, callback).let { Unit }
    }

    override fun markRead(threadId: String, callback: (RemoteResponse<MarkReadResult>) -> Unit) {
        client.markRead(threadId, callback)
    }

    override fun listSkills(
        threadId: String,
        callback: (RemoteResponse<List<ProviderSkill>?>) -> Unit,
    ) {
        client.listSkills(threadId, callback)
    }

    override fun listModels(
        threadId: String,
        callback: (RemoteResponse<List<ModelOption>?>) -> Unit,
    ) {
        client.listModels(threadId, callback)
    }

    override fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) {
        client.listProviderInstances(callback)
    }

    override fun switchInstance(
        threadId: String,
        request: ProviderInstanceSwitchRequest,
        callback: (RemoteResponse<ProviderInstanceSwitchResult>) -> Unit,
    ) {
        client.switchInstance(threadId, request, callback)
    }

    override fun archiveConversation(
        threadId: String,
        callback: (RemoteResponse<ArchiveConversationResult>) -> Unit,
    ) {
        client.archiveConversation(threadId, callback)
    }

    override fun respondToRequest(
        threadId: String,
        requestId: String,
        decision: ApprovalDecision,
        response: HostWriteResponse?,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.respondToRequest(threadId, requestId, decision, response, callback)
    }

    override fun answerQuestion(
        threadId: String,
        requestId: String,
        answers: List<List<String>>,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.answerQuestion(AnswerQuestion(threadId, requestId, answers), callback)
    }

    override fun setRuntimeMode(
        threadId: String,
        mode: RuntimeMode,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.setRuntimeMode(threadId, mode, callback)
    }

    override fun setModel(
        threadId: String,
        model: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.setModel(threadId, model, callback)
    }

    override fun interrupt(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit) {
        client.interrupt(threadId, callback)
    }

    override fun deliverPeerMessage(
        threadId: String,
        targetThreadId: String,
        text: String,
        undeliveredId: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.deliverPeerMessage(threadId, targetThreadId, text, undeliveredId, callback).let { Unit }
    }

    override fun getPendingRequests(threadId: String, callback: (RemoteResponse<List<JsonObject>>) -> Unit) {
        client.getPendingRequests(threadId, callback)
    }

    override fun listQueuedTurns(threadId: String, callback: (RemoteResponse<List<QueuedTurnSummary>>) -> Unit) {
        client.listQueuedTurns(threadId, callback)
    }

    override fun actOnQueuedTurn(
        threadId: String,
        messageId: String,
        promote: Boolean,
        callback: (RemoteResponse<QueuedTurnActionResult>) -> Unit,
    ) {
        if (promote) client.promoteQueuedTurn(threadId, messageId, callback) else client.cancelQueuedTurn(threadId, messageId, callback)
    }

    override fun pullRequestLinks(threadId: String, callback: (RemoteResponse<List<PrLink>>) -> Unit) {
        client.pullRequestLinks(threadId, callback)
    }

    override fun unlinkPullRequest(
        threadId: String,
        ref: PrLinkRef,
        callback: (RemoteResponse<PrLinkUnlinkResult>) -> Unit,
    ) {
        client.unlinkPullRequest(threadId, ref, callback)
    }

    override fun onPullRequestLinksChanged(listener: () -> Unit): Cancelable =
        client.onPullRequestLinksChanged(listener)

    override fun resumeQueuedTurns(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit) {
        client.resumeQueuedTurns(threadId, callback)
    }
}

object LoadedSessionSnapshotMapper {
    fun map(threadId: String, loaded: LoadedSession): ThreadSnapshot {
        val feed = loaded.messages.flatMap { message ->
            when (message.role.lowercase()) {
                "user" -> {
                    val text = UserMessageVisibility.visibleText(message.content, message.displayBody)
                    if (text != null || message.images.isNotEmpty()) listOf(FeedItem.User(
                        id = "h-${message.id}",
                        text = text.orEmpty(),
                        at = message.timestamp,
                        images = message.images,
                        pillsMeta = message.pillsMeta,
                        fromTranscript = message.displayBody == null,
                    )) else emptyList()
                }

                "assistant" -> buildList {
                    if (message.content.isNotBlank()) {
                        add(
                            FeedItem.Text(
                                id = "h-${message.id}",
                                messageId = message.id,
                                text = message.content,
                                stream = "assistant",
                                done = true,
                            ),
                        )
                    }
                    message.toolCalls.forEach { tool ->
                        add(
                            FeedItem.Tool(
                                id = "h-${message.id}-t-${tool.id}",
                                toolId = tool.id,
                                toolName = tool.name,
                                input = runCatching { JsonCodec.parse(tool.input) }
                                    .getOrElse { JsonString(tool.input) },
                                output = tool.output,
                                state = "done",
                            ),
                        )
                    }
                    message.fileDiff?.let { diff ->
                        // Same id as the live row, so a reload and a live event coalesce.
                        add(
                            FeedItem.FileEdit(
                                "f-${diff.fileEditId}", diff.fileEditId, diff.repoRoot, diff.relPath,
                                diff.changeKind, diff.oldContent, diff.newContent,
                            ),
                        )
                    }
                }

                else -> listOf(
                    FeedItem.RawNotice(
                        id = "h-${message.id}",
                        eventType = "history.${message.role}",
                        text = message.content,
                        raw = message.raw,
                    ),
                )
            }
        }.toMutableList<FeedItem>()
        if (loaded.truncated == true && loaded.total != null && "nextBeforeId" !in loaded.raw.values) {
            feed.add(
                0,
                FeedItem.RawNotice(
                    id = "history-window",
                    eventType = "history.window",
                    text = "Showing the last ${loaded.messages.size} of ${loaded.total} messages",
                    raw = JsonObject(
                        linkedMapOf(
                            "shown" to JsonNumber(loaded.messages.size.toString()),
                            "total" to JsonNumber(loaded.total.toString()),
                        ),
                    ),
                ),
            )
        }
        return ThreadSnapshot(threadId, feed)
    }
}

class ThreadSessionCoordinator(
    private val scope: ThreadEventScope,
    private val threadId: String,
    initialCached: ThreadState?,
    private val remote: ThreadSessionRemote,
    private val enqueue: ThreadEnqueuePort,
    private val clock: ThreadSessionClock,
    initialComposer: ComposerDraft? = null,
    private val composerPersistence: ThreadComposerPersistence = NoOpThreadComposerPersistence,
    private val snapshotStore: ThreadSnapshotStore = NoOpThreadSnapshotStore,
    private val projectPath: String? = null,
    private val worktreePath: String? = null,
    private val providerHint: String? = initialCached?.provider,
    /** Backend advertises `pending_requests_v1` - see `getPendingRequests`.
     *  False for an older backend, which has no handler for the channel. */
    private val supportsPendingRequests: Boolean = false,
    /** The backend's capabilities: the follow-up composer (`turn_queue_v1`, `turn_queue_controls_v1`) and phone approval of agent pull request writes. */
    private val capabilities: Set<String> = emptySet(),
    /** The device's "Follow-up while the agent works" choice, read at send time. */
    private val followUpDefault: () -> TurnDelivery = { TurnDelivery.Steer },
) : AutoCloseable {
    private val canQueue = TurnDeliveryPolicy.QUEUE_CAPABILITY in capabilities
    private val canControlHeld = TurnDeliveryPolicy.QUEUE_CONTROLS_CAPABILITY in capabilities
    private val heldErrors = mutableMapOf<String, String>()
    private val heldBusy = mutableSetOf<String>()
    private var heldRevision = 0L
    private var heldRequest = 0L
    private val key = ThreadKey(scope.connectionId, threadId)
    private val composerKey = ComposerDraftKey(scope.connectionId, threadId)
    private var store = ThreadStoreReducer.reduce(
        ThreadStoreState(
            threads = initialCached?.let { mapOf(key to it) }.orEmpty(),
        ),
        ThreadAction.Activate(scope.connectionId, scope.generation),
    )
    private var load: ThreadSessionLoad = initialCached?.let {
        ThreadSessionLoad.Ready(it, refreshing = !it.historyLoaded)
    } ?: ThreadSessionLoad.Loading(null)

    /**
     * A mode picked on this phone that has not reached the backend yet (an
     * offline pick, Implement's switch out of plan). It rides on the next turn
     * only. The chat's own mode (read on load, followed through
     * `session.provider`) is shown but never re-sent, so a chat set to full
     * access on the desktop is not dropped to a local default.
     */
    private var pickedMode: RuntimeMode? = initialComposer?.runtimeMode.toRuntimeModeOrNull()
    private var composer = ThreadComposerState(
        draft = initialComposer?.text.orEmpty(),
        runtimeMode = pickedMode
            ?: initialCached?.runtimeMode.toRuntimeModeOrNull()
            ?: RuntimeMode.Sandbox,
        attachments = initialComposer?.attachments.orEmpty(),
        editingOrigin = initialComposer?.editingOrigin,
    )
    private var composerHydrated = initialComposer != null
    private var composerHasUnacknowledgedLocalChanges = false
    private var controlMessage: String? = null
    private var skills: List<ProviderSkill> = emptyList()
    private var models = ThreadModelState(selectedModelId = initialCached?.resolvedModel)
    private var profiles = ThreadProfileState(selectedInstanceId = initialCached?.instanceId)
    private var archive = ThreadArchiveState()
    private var forkMetadata: ForkLineageMetadata? = initialCached?.historyMeta?.forkMetadata
    private var allProfiles: List<ProviderInstance> = emptyList()
    private var prLinks: List<PrLink> = emptyList()
    private var prLinksRequest = 0L
    private var prLinksSubscription: Cancelable? = null
    private val mutableState = MutableStateFlow(
        ThreadSessionState(load, composer, models = models, profiles = profiles),
    )
    val state = mutableState.asStateFlow()

    private var subscription: Cancelable? = null
    private var gapSubscription: Cancelable? = null
    private var started = false
    private var closed = false
    private var loadRequest = 0L
    private var modeRequest = 0L
    private var skillsRequest = 0L
    private var modelsRequest = 0L
    private var modelChangeRequest = 0L
    private var profilesRequest = 0L
    private var profileChangeRequest = 0L
    private var archiveRequest = 0L
    private var reattachRequest = 0L
    private var reattachInFlight: ProviderKind? = null
    private var attachedProvider: ProviderKind? = null
    private var attachedInstanceId: String? = initialCached?.instanceId
    private val pendingControls = mutableSetOf<String>()
    private val pendingApprovalDecisions = mutableMapOf<String, ApprovalDecision>()
    private val pendingQuestionRequestIds = mutableSetOf<String>()
    private val pendingUndeliveredIds = mutableSetOf<String>()
    private val pendingPlanOrigins = mutableMapOf<String, String>()
    private val optimisticTurns = linkedMapOf<String, app.switchboard.mobile.domain.outbox.QueuedTurn>()

    @Synchronized
    fun start() {
        if (started || closed) return
        started = true
        if (remote.scope != scope) {
            load = ThreadSessionLoad.Failed("Connection scope changed", currentThread())
            publish()
            return
        }
        reduce(ThreadAction.SetViewing(scope.connectionId, threadId, true))
        subscription = remote.subscribe(::onRuntimeEvent)
        gapSubscription = remote.subscribeGaps(::onReplayGap)
        snapshotStore.get(scope.connectionId, threadId)?.takeIf { it.historyLoaded }?.let {
            store = store.copy(threads = store.threads + (key to it.copy(unread = 0)))
        }
        currentThread()?.historyMeta?.let(::reattach) ?: reattach(providerHint)
        if (currentThread()?.historyLoaded == true && currentThread()?.awaitingReseed != true) {
            load = ThreadSessionLoad.Ready(requireNotNull(currentThread()))
            recoverPendingRequests()
            recoverHeldTurns()
            publish()
        } else refresh()
        loadSkills()
        refreshModels()
        refreshProfiles()
        prLinksSubscription = remote.onPullRequestLinksChanged(::loadPrLinks)
        loadPrLinks()
        remote.markRead(threadId) { /* best effort; local viewing state already cleared unread */ }
    }

    @Synchronized
    fun refresh() {
        if (closed || remote.scope != scope) return
        if (currentThread()?.awaitingReseed != true && scope !in store.reseedingConnections) {
            reduce(ThreadAction.ReplayGap(scope))
        }
        val request = ++loadRequest
        load = currentThread()?.takeIf { it.feed.isNotEmpty() }?.let {
            ThreadSessionLoad.Ready(it, refreshing = true)
        } ?: ThreadSessionLoad.Loading(null)
        publish()
        if ("history_window_v1" in capabilities) {
            remote.loadSessionWindow(threadId, null) { response -> acceptLoad(request, response) }
        } else remote.loadSession(threadId, HISTORY_LIMIT) { response -> acceptLoad(request, response) }
    }

    private var olderLoading = false

    @Synchronized
    fun loadOlder() {
        val before = currentThread()?.nextBeforeId ?: return
        if (closed || olderLoading || currentThread()?.awaitingReseed == true || "history_window_v1" !in capabilities) return
        olderLoading = true
        val request = loadRequest
        remote.loadSessionWindow(threadId, before) { response ->
            synchronized(this) {
                olderLoading = false
                if (!accepts(response, request, loadRequest)) return@synchronized
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> controlMessage = outcome.message
                    is RemoteOutcome.Success -> {
                        if ((outcome.value.raw.values["cursorReset"] as? JsonBoolean)?.value == true) {
                            refresh()
                            return@synchronized
                        }
                        val current = currentThread() ?: return@synchronized
                        val older = LoadedSessionSnapshotMapper.map(threadId, outcome.value).feed.filterNot { it.id == "history-window" }
                        val ids = current.feed.map { it.id }.toSet()
                        val next = current.copy(
                            feed = older.filterNot { it.id in ids } + current.feed,
                            nextBeforeId = (outcome.value.raw.values["nextBeforeId"] as? JsonString)?.value,
                        )
                        store = store.copy(threads = store.threads + (key to next))
                        load = ThreadSessionLoad.Ready(next)
                        persistSnapshot()
                    }
                }
                publish()
            }
        }
    }

    @Synchronized
    fun onReplayGap(eventScope: ThreadEventScope) {
        if (closed || eventScope != scope) return
        reduce(ThreadAction.ReplayGap(eventScope))
        refresh()
    }

    @Synchronized
    fun clearVisibleFeed() {
        val current = currentThread() ?: return
        store = store.copy(threads = store.threads + (key to current.copy(feed = emptyList())))
        load = when (val currentLoad = load) {
            is ThreadSessionLoad.Loading -> currentLoad.copy(cached = currentThread())
            is ThreadSessionLoad.Failed -> currentLoad.copy(cached = currentThread())
            is ThreadSessionLoad.Ready -> currentLoad.copy(thread = requireNotNull(currentThread()))
        }
        publish()
    }

    @Synchronized
    fun currentThread(): ThreadState? = store.thread(scope.connectionId, threadId)

    @Synchronized
    fun updateDraft(text: String) {
        composer = composer.copy(draft = text, error = null)
        composerHasUnacknowledgedLocalChanges = true
        persistComposer()
        publish()
    }

    @Synchronized
    fun submit(): ComposerSubmitResult {
        if (composer.submitting || profiles.changing) return ComposerSubmitResult.Busy
        val text = composer.draft.trim()
        if (text.isEmpty() && composer.attachments.isEmpty()) return ComposerSubmitResult.Empty
        composer = composer.copy(submitting = true, error = null)
        publish()
        val thread = currentThread()
        val result = enqueueDraft(
            text = text,
            mode = pickedMode,
            attachments = composer.attachments,
            editingOrigin = composer.editingOrigin,
            delivery = TurnDeliveryPolicy.requestedDelivery(
                provider = thread?.provider ?: providerHint,
                running = thread?.status == "running",
                preferred = followUpDefault(),
                flipped = composer.flipNextDelivery,
            ),
        )
        return when (result) {
            is EnqueueResult.Durable -> {
                addOptimistic(result.turn)
                pickedMode = null
                val cleared = composerPersistence.clear(composerKey)
                composer = if (cleared) {
                    composerHasUnacknowledgedLocalChanges = false
                    composer.copy(
                        draft = "",
                        attachments = emptyList(),
                        editingOrigin = null,
                        submitting = false,
                        error = null,
                        flipNextDelivery = false,
                    )
                } else {
                    composer.copy(
                        submitting = false,
                        error = "Message queued, but the saved draft could not be cleared",
                    )
                }
                publish()
                ComposerSubmitResult.Durable(result.turn)
            }

            is EnqueueResult.AttachmentFailure -> submitFailed(result.reason)
            is EnqueueResult.StorageFailure -> submitFailed(result.reason)
        }
    }

    /**
     * A one-tap action's own turn (the compaction-offer banner's "Compact"),
     * sent through the same durable enqueue as [submit]. Mirrors
     * `send(textOverride)` in ThreadScreen.tsx: it does not read or clear the
     * composer's draft or attachments, so what the user was typing survives.
     */
    @Synchronized
    fun submitText(text: String): ComposerSubmitResult {
        // Same reentrancy guard as submit(): a second tap (e.g. the compaction-offer
        // banner's Compact button) while one of these is already in flight must not
        // enqueue a second turn.
        if (composer.submitting || profiles.changing) return ComposerSubmitResult.Busy
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return ComposerSubmitResult.Empty
        composer = composer.copy(submitting = true, error = null)
        publish()
        val result = enqueueDraft(
            text = trimmed,
            mode = pickedMode,
            attachments = emptyList(),
            editingOrigin = null,
        )
        return when (result) {
            is EnqueueResult.Durable -> {
                addOptimistic(result.turn)
                pickedMode = null
                composer = composer.copy(submitting = false, error = null)
                publish()
                ComposerSubmitResult.Durable(result.turn)
            }
            is EnqueueResult.AttachmentFailure -> submitFailed(result.reason)
            is EnqueueResult.StorageFailure -> submitFailed(result.reason)
        }
    }

    @Synchronized
    fun selectRuntimeMode(mode: RuntimeMode) {
        if (closed || composer.modeChanging || remote.scope != scope) return
        val request = ++modeRequest
        composer = composer.copy(modeChanging = true, error = null)
        publish()
        remote.setRuntimeMode(threadId, mode) { response ->
            synchronized(this) {
                if (!accepts(response, request, modeRequest)) return@synchronized
                composer = when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> composer.copy(
                        runtimeMode = mode,
                        modeChanging = false,
                        error = null,
                    )

                    is RemoteOutcome.Failure -> composer.copy(
                        modeChanging = false,
                        error = outcome.message,
                    )
                }
                if (response.outcome is RemoteOutcome.Success) {
                    // Applied, so no turn needs to carry it.
                    pickedMode = null
                    composerHasUnacknowledgedLocalChanges = true
                    persistComposer()
                }
                publish()
            }
        }
    }

    @Synchronized
    fun refreshModels() {
        if (closed || remote.scope != scope) return
        val request = ++modelsRequest
        models = models.copy(loading = true, error = null)
        publish()
        try {
            remote.listModels(threadId) { response ->
                synchronized(this) {
                    if (!accepts(response, request, modelsRequest)) return@synchronized
                    models = when (val outcome = response.outcome) {
                        is RemoteOutcome.Success -> outcome.value.orEmpty().let { options ->
                            models.copy(
                                options = options,
                                selectedModelId = if (options.isEmpty()) {
                                    models.selectedModelId
                                } else {
                                    models.selectedModelId?.takeIf { selected ->
                                        options.any { it.id == selected }
                                    }
                                },
                                loading = false,
                                error = null,
                            )
                        }
                        is RemoteOutcome.Failure -> models.copy(
                            loading = false,
                            error = outcome.message,
                        )
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            if (request != modelsRequest) return
            models = models.copy(
                loading = false,
                error = error.message ?: "Could not load models",
            )
            publish()
        }
    }

    @Synchronized
    fun selectModel(modelId: String) {
        if (closed || models.changing || remote.scope != scope) return
        if (models.options.none { it.id == modelId }) {
            models = models.copy(error = "Model is not available for this session")
            publish()
            return
        }
        val request = ++modelChangeRequest
        models = models.copy(changing = true, error = null)
        publish()
        try {
            remote.setModel(threadId, modelId) { response ->
                synchronized(this) {
                    if (!accepts(response, request, modelChangeRequest)) return@synchronized
                    models = when (val outcome = response.outcome) {
                        is RemoteOutcome.Success -> models.copy(
                            selectedModelId = modelId,
                            changing = false,
                            error = null,
                        )
                        is RemoteOutcome.Failure -> models.copy(
                            changing = false,
                            error = outcome.message,
                        )
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            if (request != modelChangeRequest) return
            models = models.copy(
                changing = false,
                error = error.message ?: "Could not change model",
            )
            publish()
        }
    }

    @Synchronized
    fun refreshProfiles() {
        if (closed || remote.scope != scope) return
        val request = ++profilesRequest
        profiles = profiles.copy(loading = true, error = null)
        publish()
        try {
            remote.listProviderInstances { response ->
                synchronized(this) {
                    if (!accepts(response, request, profilesRequest)) return@synchronized
                    when (val outcome = response.outcome) {
                        is RemoteOutcome.Success -> {
                            allProfiles = outcome.value
                            profiles = profiles.copy(loading = false, error = null)
                            syncProfiles()
                        }
                        is RemoteOutcome.Failure -> profiles = profiles.copy(
                            loading = false,
                            error = outcome.message,
                        )
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            if (request != profilesRequest) return
            profiles = profiles.copy(
                loading = false,
                error = error.message ?: "Could not load profiles",
            )
            publish()
        }
    }

    @Synchronized
    fun selectProfile(instanceId: String) {
        if (closed || remote.scope != scope || profiles.changing) return
        if (currentThread()?.status == "running") {
            profiles = profiles.copy(error = "Stop the current turn before switching profile")
            publish()
            return
        }
        val target = profiles.options.firstOrNull { it.id == instanceId }
        if (target == null) {
            profiles = profiles.copy(error = "Profile is not available for this provider")
            publish()
            return
        }
        if (profiles.selectedInstanceId == instanceId) return

        val request = ++profileChangeRequest
        profiles = profiles.copy(changing = true, switchingTo = target.displayName.ifBlank { target.id }, error = null)
        publish()
        remote.switchInstance(
            threadId,
            ProviderInstanceSwitchRequest(
                targetInstanceId = target.id,
                expectedCurrentInstanceId = profiles.selectedInstanceId,
            ),
        ) { response ->
            synchronized(this) {
                if (!accepts(response, request, profileChangeRequest)) return@synchronized
                var switched = false
                profiles = when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> profiles.copy(
                        changing = false,
                        error = outcome.message,
                    )
                    is RemoteOutcome.Success -> when (val result = outcome.value) {
                        is ProviderInstanceSwitchResult.Success -> profiles.copy(
                            selectedInstanceId = result.instanceId,
                            changing = false,
                            error = null,
                        ).also { switched = true }
                        is ProviderInstanceSwitchResult.Failure -> profiles.copy(
                            selectedInstanceId = if (result.rolledBack == false) {
                                result.currentInstanceId
                            } else {
                                result.currentInstanceId ?: profiles.selectedInstanceId
                            },
                            changing = false,
                            error = result.message,
                        )
                    }
                }
                publish()
                if (switched) {
                    loadSkills()
                    refreshModels()
                }
            }
        }
    }

    @Synchronized
    fun archive(onArchived: () -> Unit) {
        if (closed || remote.scope != scope || archive.archiving) return
        if (currentThread()?.status in ACTIVE_PROVIDER_STATUSES) {
            archive = archive.copy(error = "Stop the current turn before archiving")
            publish()
            return
        }
        val request = ++archiveRequest
        archive = ThreadArchiveState(archiving = true)
        publish()
        try {
            remote.archiveConversation(threadId) { response ->
                val confirmed = synchronized(this) {
                    if (!accepts(response, request, archiveRequest)) return@synchronized false
                    when (val outcome = response.outcome) {
                        is RemoteOutcome.Success -> {
                            archive = ThreadArchiveState()
                            publish()
                            outcome.value == ArchiveConversationResult.Archived
                        }
                        is RemoteOutcome.Failure -> {
                            archive = ThreadArchiveState(error = outcome.message)
                            publish()
                            false
                        }
                    }
                }
                if (confirmed) onArchived()
            }
        } catch (error: RuntimeException) {
            if (request != archiveRequest) return
            archive = ThreadArchiveState(error = error.message ?: "Could not archive conversation")
            publish()
        }
    }

    @Synchronized
    fun interrupt() {
        if (closed || composer.interrupting || remote.scope != scope) return
        composer = composer.copy(interrupting = true, error = null)
        publish()
        remote.interrupt(threadId) { response ->
            synchronized(this) {
                if (!accepts(response)) return@synchronized
                composer = when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> {
                        // No turn on the backend (its end fell into a resume gap): no
                        // closing event will come, so clear the status here.
                        if (outcome.value.foundNoTurn) settleStaleRunning()
                        composer.copy(interrupting = false, error = null)
                    }
                    is RemoteOutcome.Failure -> composer.copy(interrupting = false, error = outcome.message)
                }
                publish()
            }
        }
    }

    private fun settleStaleRunning() {
        val status = currentThread()?.status ?: return
        if (status == "running" || status == "thinking") replaceThreadStatus("idle")
    }

    private fun replaceThreadStatus(status: String) {
        val thread = currentThread() ?: return
        store = store.copy(threads = store.threads + (key to thread.copy(status = status)))
        load = when (val current = load) {
            is ThreadSessionLoad.Loading -> ThreadSessionLoad.Loading(currentThread())
            is ThreadSessionLoad.Failed -> current.copy(cached = currentThread())
            is ThreadSessionLoad.Ready -> current.copy(thread = requireNotNull(currentThread()))
        }
        persistSnapshot()
    }

    /** The composer chip: the next send steers instead of queueing, or the other way round. */
    @Synchronized
    fun toggleNextDelivery() {
        composer = composer.copy(flipNextDelivery = !composer.flipNextDelivery)
        publish()
    }

    /**
     * Send now (steer a held message into the running turn) or Cancel (take
     * it back; its text returns to the composer). The row itself goes on the
     * backend's turn.dequeued. A refusal shows on the row, not as a thread
     * error, which would hide Stop on a still-running thread.
     */
    @Synchronized
    fun actOnHeld(messageId: String, promote: Boolean) {
        if (closed || !canControlHeld || remote.scope != scope || !heldBusy.add(messageId)) return
        heldErrors.remove(messageId)
        publish()
        try {
            remote.actOnQueuedTurn(threadId, messageId, promote) { response ->
                synchronized(this) {
                    heldBusy -= messageId
                    if (!accepts(response) || closed) return@synchronized
                    when (val outcome = response.outcome) {
                        is RemoteOutcome.Failure -> heldErrors[messageId] = outcome.message
                        is RemoteOutcome.Success -> when (val result = outcome.value) {
                            is QueuedTurnActionResult.Refused -> heldErrors[messageId] = result.message
                            is QueuedTurnActionResult.Done -> if (!promote && result.text.isNotEmpty()) {
                                val draft = composer.draft
                                composer = composer.copy(draft = if (draft.isEmpty()) result.text else "$draft\n\n${result.text}")
                                composerHasUnacknowledgedLocalChanges = true
                                persistComposer()
                            }
                        }
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            heldBusy -= messageId
            heldErrors[messageId] = error.message ?: "Request failed"
            publish()
        }
    }

    /** Resume a held queue; a refusal shows on the row that was tapped. */
    @Synchronized
    fun resumeHeld(messageId: String) {
        if (closed || !canControlHeld || remote.scope != scope || !heldBusy.add(messageId)) return
        heldErrors.remove(messageId)
        publish()
        try {
            remote.resumeQueuedTurns(threadId) { response ->
                synchronized(this) {
                    heldBusy -= messageId
                    if (!accepts(response) || closed) return@synchronized
                    when (val outcome = response.outcome) {
                        is RemoteOutcome.Failure -> heldErrors[messageId] = outcome.message
                        is RemoteOutcome.Success -> {
                            val body = outcome.value.body as? JsonObject
                            if ((body?.values?.get("ok") as? JsonBoolean)?.value == false) {
                                heldErrors[messageId] = (body.values["message"] as? JsonString)?.value ?: "Nothing is held for this chat."
                            }
                        }
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            heldBusy -= messageId
            heldErrors[messageId] = error.message ?: "Request failed"
            publish()
        }
    }

    @Synchronized
    fun perform(control: ThreadSessionControl): ThreadControlOutcome = when (control) {
        is ThreadSessionControl.Approval -> requestControl(
            key = "approval:${control.requestId}",
            requestId = control.requestId,
            onPending = { pendingApprovalDecisions[control.requestId] = control.decision },
            onFinished = { pendingApprovalDecisions.remove(control.requestId) },
        ) { callback -> remote.respondToRequest(threadId, control.requestId, control.decision, control.response, callback) }

        is ThreadSessionControl.AnswerQuestion -> requestControl(
            key = "question:${control.requestId}",
            requestId = control.requestId,
            onPending = { pendingQuestionRequestIds += control.requestId },
            onFinished = { pendingQuestionRequestIds -= control.requestId },
        ) { callback -> remote.answerQuestion(threadId, control.requestId, control.answers, callback) }

        is ThreadSessionControl.Plan -> when (control.action) {
            ThreadSessionPlanAction.Implement -> implementPlan(control.planId)
            ThreadSessionPlanAction.Iterate -> {
                composer = composer.copy(focusRequest = composer.focusRequest + 1)
                publish()
                ThreadControlOutcome.ComposerFocused
            }
        }

        is ThreadSessionControl.SendUndelivered -> sendUndelivered(control)

        is ThreadSessionControl.OpenFile -> {
            val message = OPEN_FILE_UNSUPPORTED
            controlMessage = message
            publish()
            ThreadControlOutcome.Unsupported(message)
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        loadRequest += 1
        modeRequest += 1
        skillsRequest += 1
        modelsRequest += 1
        modelChangeRequest += 1
        profilesRequest += 1
        profileChangeRequest += 1
        archiveRequest += 1
        reattachRequest += 1
        prLinksRequest += 1
        subscription?.cancel()
        gapSubscription?.cancel()
        prLinksSubscription?.cancel()
        gapSubscription = null
        subscription = null
        prLinksSubscription = null
        reduce(ThreadAction.SetViewing(scope.connectionId, threadId, false))
    }

    private fun acceptLoad(request: Long, response: RemoteResponse<LoadedSession>) {
        synchronized(this) {
            if (!accepts(response, request, loadRequest)) return
            when (val outcome = response.outcome) {
                is RemoteOutcome.Success -> {
                    forkMetadata = outcome.value.meta?.forkMetadata
                    reduce(
                        ThreadAction.InstallSnapshot(
                            scope,
                            LoadedSessionSnapshotMapper.map(threadId, outcome.value),
                        ),
                    )
                    currentThread()?.let {
                        store = store.copy(threads = store.threads + (key to it.copy(
                            historyLoaded = true,
                            historyMeta = outcome.value.meta,
                            nextBeforeId = (outcome.value.raw.values["nextBeforeId"] as? JsonString)?.value,
                        )))
                    }
                    reconcileOptimisticHistory()
                    optimisticTurns.values.forEach(::addOptimistic)
                    reduce(ThreadAction.CompleteReseed(scope))
                    outcome.value.meta?.runtimeMode.toRuntimeModeOrNull()?.let { followBackendMode(it, supersedesPick = false) }
                    load = ThreadSessionLoad.Ready(requireNotNull(currentThread()))
                    persistSnapshot()
                    reattach(outcome.value)
                    recoverPendingRequests()
                    recoverHeldTurns()
                }

                is RemoteOutcome.Failure -> {
                    load = ThreadSessionLoad.Failed(outcome.message, currentThread())
                }
            }
            publish()
        }
    }

    /**
     * Recover any approval/question/plan card a resume gap or a reload
     * dropped. Called after every successful `refresh()` - both a thread
     * (re)open and a resume gap (`onReplayGap` -> `refresh()`) land here, the
     * same way ThreadScreen's single seed effect covers both on mobile.
     *
     * Each returned event is checked against `isAlreadyShown` first: `upsert`
     * replaces a feed item with the same id in place, so an unfiltered replay
     * would turn an already-resolved card back into "pending" if the recovery
     * reply lands after the live close/answer that resolved it.
     */
    private fun recoverPendingRequests() {
        if (!supportsPendingRequests) return
        // Cards open before the call that the backend no longer holds can never
        // be answered (their provider died meanwhile). One that opens while the
        // call is on the wire is not in this set, so it is kept.
        val openBefore = ExpiredRequests.openRequestIds(currentThread()?.feed.orEmpty())
        try {
            remote.getPendingRequests(threadId) { response ->
                synchronized(this) {
                    if (!accepts(response) || closed || remote.scope != scope) return@synchronized
                    // Recovery is best-effort: a Failure outcome (offline, an
                    // older backend, a transient error) just means this pass
                    // recovers nothing - the next refresh() (thread reopen,
                    // resume gap) tries again.
                    val pending = (response.outcome as? RemoteOutcome.Success)?.value ?: return@synchronized
                    var changed = false
                    val held = pending.mapNotNullTo(mutableSetOf()) { (it.values["requestId"] as? JsonString)?.value }
                    for (requestId in openBefore - held) {
                        reduce(ThreadAction.Runtime(ScopedThreadEvent(scope, null, ThreadEventDecoder.decode(ExpiredRequests.event(threadId, requestId)), nowMs = clock.nowMs())))
                        changed = true
                    }
                    for (raw in pending) {
                        val event = ThreadEventDecoder.decode(raw)
                        if (event.threadId != threadId) continue
                        // upsert() replaces a feed item that already has this id, so a
                        // recovered event for a card the user already resolved (a live
                        // request.closed/question.answered landed before this reply came
                        // back) would turn it back into "pending". Skip it instead.
                        if (isAlreadyShown(event)) continue
                        reduce(ThreadAction.Runtime(ScopedThreadEvent(scope, null, event, nowMs = clock.nowMs())))
                        changed = true
                    }
                    if (changed) {
                        load = when (val current = load) {
                            is ThreadSessionLoad.Loading -> ThreadSessionLoad.Loading(currentThread())
                            is ThreadSessionLoad.Failed -> current.copy(cached = currentThread())
                            is ThreadSessionLoad.Ready -> current.copy(thread = requireNotNull(currentThread()))
                        }
                        persistSnapshot()
                        publish()
                    }
                }
            }
        } catch (_: RuntimeException) {
            // Recovery is optional, like loadSkills()/refreshModels() above -
            // the feed the ordinary load already installed remains usable.
        }
    }

    /**
     * Re-list the messages the backend still holds, so Queued rows survive a
     * reload or a resume gap. A live turn.queued / turn.dequeued that lands
     * while the backend answers makes the answer stale; ask again rather than
     * undo it (at most [HELD_RECOVERY_ATTEMPTS] times, like the phone).
     */
    private fun recoverHeldTurns(attempt: Int = 1) {
        if (!canControlHeld) return
        val revision = heldRevision
        val request = ++heldRequest
        try {
            remote.listQueuedTurns(threadId) { response ->
                synchronized(this) {
                    if (!accepts(response, request, heldRequest) || closed || remote.scope != scope) return@synchronized
                    val held = when (val outcome = response.outcome) {
                        is RemoteOutcome.Failure -> {
                            controlMessage = heldListFailure(outcome.message)
                            publish()
                            return@synchronized
                        }
                        is RemoteOutcome.Success -> outcome.value
                    }
                    if (controlMessage?.startsWith(HELD_LIST_FAILURE) == true) controlMessage = null
                    if (heldRevision != revision) {
                        if (attempt < HELD_RECOVERY_ATTEMPTS) recoverHeldTurns(attempt + 1)
                        return@synchronized
                    }
                    reduce(
                        ThreadAction.SeedHeldTurns(
                            scope.connectionId,
                            threadId,
                            held.mapTo(mutableSetOf()) { it.messageId },
                            queueHeld = held.any { it.held },
                            failed = held.mapNotNull { turn -> turn.failed?.let { turn.messageId to it } }.toMap(),
                        ),
                    )
                    load = when (val current = load) {
                        is ThreadSessionLoad.Loading -> ThreadSessionLoad.Loading(currentThread())
                        is ThreadSessionLoad.Failed -> current.copy(cached = currentThread())
                        is ThreadSessionLoad.Ready -> current.copy(thread = requireNotNull(currentThread()))
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            // Live events still mark new held messages; say why older ones may be unmarked.
            controlMessage = heldListFailure(error.message ?: "request failed")
        }
    }

    /** A recovered request.opened / question.asked / plan.proposed whose
     *  requestId/planId is already on an Approval, Question or Plan item in
     *  the current feed - same dedupe desktop and mobile do before appending
     *  a recovered card, so a late reply cannot undo an already-resolved one. */
    private fun isAlreadyShown(event: app.switchboard.mobile.domain.thread.ThreadRuntimeEvent): Boolean {
        val known = event as? app.switchboard.mobile.domain.thread.ThreadRuntimeEvent.Known ?: return false
        val feed = currentThread()?.feed ?: return false
        return when (val payload = known.payload) {
            is app.switchboard.mobile.domain.thread.ThreadEventPayload.RequestOpened ->
                feed.any { it is FeedItem.Approval && it.requestId == payload.requestId }
            is app.switchboard.mobile.domain.thread.ThreadEventPayload.QuestionAsked ->
                feed.any { it is FeedItem.Question && it.requestId == payload.requestId }
            is app.switchboard.mobile.domain.thread.ThreadEventPayload.PlanProposed ->
                feed.any { it is FeedItem.Plan && it.planId == payload.planId }
            else -> false
        }
    }

    private fun reattach(loaded: LoadedSession) {
        loaded.meta?.let(::reattach)
    }

    private fun reattach(meta: SessionMeta) {
        reattach(
            agentType = meta.agentType,
            cwdOverride = meta.worktreePath ?: worktreePath ?: meta.projectPath,
            instanceId = meta.providerInstanceId,
            model = meta.model,
            runtimeMode = meta.runtimeMode?.toRuntimeModeOrNull(),
            nativeResume = meta.forkMetadata?.resumeMode != "transcript-handoff",
        )
    }

    private fun reattach(
        agentType: String?,
        cwdOverride: String? = null,
        instanceId: String? = null,
        model: String? = null,
        runtimeMode: RuntimeMode? = null,
        nativeResume: Boolean = true,
    ) {
        if (agentType == null) return
        val cwd = cwdOverride ?: worktreePath ?: projectPath ?: return
        val provider = providerKind(agentType)
        if (provider == null) {
            controlMessage = "Cannot reattach unknown provider $agentType"
            return
        }
        if (
            attachedProvider == provider ||
            reattachInFlight == provider
        ) return
        val request = ++reattachRequest
        reattachInFlight = provider
        publish()
        try {
            remote.startSession(
                StartSession(
                    threadId = threadId,
                    provider = provider,
                    cwd = cwd,
                    resumeSessionId = threadId.takeIf { nativeResume },
                    instanceId = instanceId,
                    model = model,
                    runtimeMode = runtimeMode,
                ),
            ) { response ->
                synchronized(this) {
                    if (!accepts(response) || request != reattachRequest) return@synchronized
                    reattachInFlight = null
                    when (val outcome = response.outcome) {
                        is RemoteOutcome.Success -> {
                            attachedProvider = provider
                            attachedInstanceId = currentThread()?.instanceId
                            controlMessage = null
                            // A reattach to a live session answers with its status and emits
                            // none, so an idle chat kept the cached or default "connecting"
                            // ("Reconnecting") until its next turn.
                            replaceThreadStatus(outcome.value.status)
                        }
                        is RemoteOutcome.Failure -> controlMessage = outcome.message
                    }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            reattachInFlight = null
            val message = error.message ?: "Could not reattach session"
            controlMessage = message
            publish()
        }
    }

    private fun onRuntimeEvent(eventScope: ThreadEventScope, payload: RuntimeEventPayload) {
        synchronized(this) {
            if (closed || eventScope != scope || payload.threadId != threadId) return
            val event = ThreadEventDecoder.decode(payload.raw)
            if (event.threadId != threadId) return
            val known = event as? app.switchboard.mobile.domain.thread.ThreadRuntimeEvent.Known
            when (val decoded = known?.payload) {
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.RequestClosed -> {
                    pendingControls -= "approval:${decoded.requestId}"
                    pendingApprovalDecisions.remove(decoded.requestId)
                }
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.RequestExpired -> {
                    pendingControls -= "approval:${decoded.requestId}"
                    pendingControls -= "question:${decoded.requestId}"
                    pendingApprovalDecisions.remove(decoded.requestId)
                    pendingQuestionRequestIds -= decoded.requestId
                }
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.QuestionAnswered -> {
                    pendingControls -= "question:${decoded.requestId}"
                    pendingQuestionRequestIds -= decoded.requestId
                }
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.TurnQueued -> heldRevision += 1
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.TurnDequeued -> {
                    heldRevision += 1
                    heldErrors.remove(decoded.messageId)
                }
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.UserMessage -> {
                    val origin = decoded.origin
                    if (origin != null) {
                        optimisticTurns.remove(origin)
                        pendingPlanOrigins.entries.removeAll { it.value == origin }
                    }
                }
                else -> Unit
            }
            val previousInstanceId = attachedInstanceId
            reduce(
                ThreadAction.Runtime(
                    ScopedThreadEvent(eventScope, payload.sequence, event, nowMs = clock.nowMs()),
                ),
            )
            val providerEvent = known?.payload as?
                app.switchboard.mobile.domain.thread.ThreadEventPayload.SessionProvider
            if (providerEvent != null) {
                providerEvent.runtimeMode.toRuntimeModeOrNull()?.let { followBackendMode(it, supersedesPick = true) }
                attachedInstanceId = providerEvent.instanceId
                val provider = providerKind(providerEvent.provider)
                profiles = profiles.copy(
                    options = provider?.let {
                        NewSessionDecisions.profiles(allProfiles, it)
                    }.orEmpty(),
                    selectedInstanceId = providerEvent.instanceId,
                )
                if (attachedInstanceId != previousInstanceId) {
                    loadSkills()
                    refreshModels()
                }
            }
            currentThread()?.resolvedModel?.let { resolvedModel ->
                models = models.copy(selectedModelId = resolvedModel)
            }
            load = when (val current = load) {
                is ThreadSessionLoad.Loading -> ThreadSessionLoad.Loading(currentThread())
                is ThreadSessionLoad.Failed -> current.copy(cached = currentThread())
                is ThreadSessionLoad.Ready -> current.copy(thread = requireNotNull(currentThread()))
            }
            persistSnapshot()
            publish()
        }
    }

    private fun requestControl(
        key: String,
        requestId: String,
        onPending: () -> Unit,
        onFinished: () -> Unit,
        request: (((RemoteResponse<CommandBody>) -> Unit) -> Unit),
    ): ThreadControlOutcome {
        if (closed || remote.scope != scope) return ThreadControlOutcome.Failed("Connection scope changed")
        if (!pendingControls.add(key)) return ThreadControlOutcome.Busy
        onPending()
        controlMessage = null
        publish()
        try {
            request { response ->
                synchronized(this) {
                    if (!accepts(response)) return@synchronized
                    val failure = response.outcome as? RemoteOutcome.Failure
                    if (failure != null) {
                        pendingControls -= key
                        onFinished()
                        controlMessage = failure.message
                        // Nothing waits for this answer any more: close the card too.
                        if (failure.message.contains(ExpiredRequests.REFUSED)) {
                            reduce(ThreadAction.Runtime(ScopedThreadEvent(scope, null, ThreadEventDecoder.decode(ExpiredRequests.event(threadId, requestId)), nowMs = clock.nowMs())))
                            persistSnapshot()
                        }
                        publish()
                    }
                }
            }
        } catch (error: RuntimeException) {
            pendingControls -= key
            onFinished()
            return controlFailed(error.message ?: "Request failed")
        }
        return ThreadControlOutcome.Requested
    }

    /**
     * Unlike an approval, no event closes this on success when the backend
     * declines to mark the row (it was not this row's message), so the pending
     * flag clears on any answer; a sent row then drops its button.
     */
    private fun sendUndelivered(control: ThreadSessionControl.SendUndelivered): ThreadControlOutcome {
        if (closed || remote.scope != scope) return ThreadControlOutcome.Failed("Connection scope changed")
        if (!pendingUndeliveredIds.add(control.messageId)) return ThreadControlOutcome.Busy
        controlMessage = null
        publish()
        try {
            remote.deliverPeerMessage(threadId, control.targetThreadId, control.text, control.messageId) { response ->
                synchronized(this) {
                    if (!accepts(response)) return@synchronized
                    pendingUndeliveredIds -= control.messageId
                    (response.outcome as? RemoteOutcome.Failure)?.let { controlMessage = it.message }
                    publish()
                }
            }
        } catch (error: RuntimeException) {
            pendingUndeliveredIds -= control.messageId
            return controlFailed(error.message ?: "Request failed")
        }
        return ThreadControlOutcome.Requested
    }

    private fun implementPlan(planId: String): ThreadControlOutcome {
        if (closed || remote.scope != scope) return ThreadControlOutcome.Failed("Connection scope changed")
        if (planId in pendingPlanOrigins) return ThreadControlOutcome.Busy
        composer = composer.copy(runtimeMode = RuntimeMode.Sandbox, error = null)
        publish()
        try {
            remote.setRuntimeMode(threadId, RuntimeMode.Sandbox) { /* best effort */ }
        } catch (_: RuntimeException) {
            // The durable enqueue below remains the authoritative outcome.
        }
        return when (val result = enqueueDraft(IMPLEMENT_PLAN_MESSAGE, RuntimeMode.Sandbox)) {
            is EnqueueResult.Durable -> {
                pickedMode = null
                pendingPlanOrigins[planId] = result.turn.origin
                optimisticTurns[result.turn.origin] = result.turn
                addOptimistic(result.turn)
                publish()
                ThreadControlOutcome.Durable(result.turn)
            }
            is EnqueueResult.AttachmentFailure -> controlFailed(result.reason)
            is EnqueueResult.StorageFailure -> controlFailed(result.reason)
        }
    }

    private fun enqueueDraft(
        text: String,
        mode: RuntimeMode?,
        attachments: List<ComposerAttachment> = emptyList(),
        editingOrigin: String? = null,
        delivery: TurnDelivery? = null,
    ): EnqueueResult = try {
        val draft = OutgoingTurnDraft(
                connectionId = scope.connectionId,
                threadId = threadId,
                text = text,
                attachments = attachments.map { attachment ->
                    app.switchboard.mobile.domain.outbox.AttachmentDraft(
                        sourceUri = "",
                        mimeType = attachment.mimeType,
                        privateSourcePath = attachment.privateUri,
                    )
                },
                runtimeMode = mode?.wire,
                createdAtMs = clock.nowMs(),
                delivery = delivery?.wire,
            )
        editingOrigin?.let { enqueue.replace(it, draft) } ?: enqueue.enqueue(draft)
    } catch (error: RuntimeException) {
        EnqueueResult.StorageFailure(error.message ?: "Could not save message")
    }

    private fun submitFailed(message: String): ComposerSubmitResult.Failed {
        composer = composer.copy(submitting = false, error = message)
        publish()
        return ComposerSubmitResult.Failed(message)
    }

    private fun controlFailed(message: String): ThreadControlOutcome.Failed {
        controlMessage = message
        publish()
        return ThreadControlOutcome.Failed(message)
    }

    private fun reduce(action: ThreadAction) {
        store = ThreadStoreReducer.reduce(store, action)
    }

    private fun addOptimistic(turn: app.switchboard.mobile.domain.outbox.QueuedTurn) {
        optimisticTurns[turn.origin] = turn
        val current = currentThread() ?: ThreadState()
        val item = FeedItem.User(
            id = turn.bubbleId,
            text = turn.text,
            at = turn.createdAtMs,
            images = turn.attachments.map { attachment ->
                val file = File(attachment.privateUri)
                app.switchboard.mobile.domain.remote.MessageImage(
                    url = file.toURI().toString(),
                    mimeType = attachment.mimeType,
                    name = file.name,
                )
            },
        )
        if (current.feed.any { it.id == "h-${item.id}" }) return
        val index = current.feed.indexOfFirst { it.id == item.id }
        val feed = if (index < 0) {
            current.feed + item
        } else {
            current.feed.toMutableList().also { it[index] = item }
        }
        store = store.copy(threads = store.threads + (key to current.copy(feed = feed)))
        load = when (val currentLoad = load) {
            is ThreadSessionLoad.Loading -> currentLoad.copy(cached = currentThread())
            is ThreadSessionLoad.Failed -> currentLoad.copy(cached = currentThread())
            is ThreadSessionLoad.Ready -> currentLoad.copy(thread = requireNotNull(currentThread()))
        }
    }

    private fun reconcileOptimisticHistory() {
        val ids = currentThread()?.feed?.mapTo(mutableSetOf(), FeedItem::id).orEmpty()
        val delivered = optimisticTurns.values
            .filter { "h-${it.bubbleId}" in ids }
            .mapTo(mutableSetOf()) { it.origin }
        if (delivered.isEmpty()) return
        delivered.forEach(optimisticTurns::remove)
        pendingPlanOrigins.entries.removeAll { it.value in delivered }
    }

    private fun publish() {
        mutableState.value = ThreadSessionState(
            load = load,
            composer = composer,
            controlMessage = when {
                profiles.changing -> "Switching to ${profiles.switchingTo}..."
                reattachInFlight != null -> "Starting ${reattachInFlight}..."
                else -> controlMessage
            },
            skills = skills,
            models = models,
            profiles = profiles,
            archive = archive,
            pendingActions = ThreadPendingActions(
                approvalDecisions = pendingApprovalDecisions.toMap(),
                questionRequestIds = pendingQuestionRequestIds.toSet(),
                undeliveredIds = pendingUndeliveredIds.toSet(),
                planIds = pendingPlanOrigins.keys.toSet(),
                backendTakesPhoneApproval = HostWriteCards.PHONE_APPROVAL_CAPABILITY in capabilities,
                backendAsyncApproval = HostWriteCards.ASYNC_APPROVAL_CAPABILITY in capabilities,
            ),
            forkMetadata = forkMetadata,
            followUp = ThreadFollowUpState(
                preferred = followUpDefault(),
                canQueue = canQueue,
                canControlHeld = canControlHeld,
                heldErrors = heldErrors.toMap(),
                heldBusy = heldBusy.toSet(),
            ),
            prLinks = prLinks,
        )
    }

    private fun loadSkills() {
        val request = ++skillsRequest
        try {
            remote.listSkills(threadId) { response ->
                synchronized(this) {
                    if (!accepts(response, request, skillsRequest)) return@synchronized
                    val outcome = response.outcome as? RemoteOutcome.Success ?: return@synchronized
                    skills = outcome.value.orEmpty()
                    publish()
                }
            }
        } catch (_: RuntimeException) {
            // Skills are optional; built-in slash commands remain available.
        }
    }

    /**
     * Re-read the pull requests linked to this chat. Called on start and on
     * `pull-requests:links-changed`, since the event names the root chat
     * rather than this thread's id. Best-effort like [loadSkills]: an older
     * backend has no handler for the channel, so a Failure just leaves the
     * banner showing whatever it last had (empty, on a first load).
     */
    @Synchronized
    private fun loadPrLinks() {
        if (closed || remote.scope != scope) return
        val request = ++prLinksRequest
        try {
            remote.pullRequestLinks(threadId) { response ->
                synchronized(this) {
                    if (!accepts(response, request, prLinksRequest) || closed || remote.scope != scope) return@synchronized
                    (response.outcome as? RemoteOutcome.Success)?.let { prLinks = it.value }
                    publish()
                }
            }
        } catch (_: RuntimeException) {
            // Pull request links are optional; the banner stays as it was.
        }
    }

    /** Unlink a pull request from this chat. The links list itself is not
     *  updated here - a successful unlink fires `pull-requests:links-changed`
     *  on the backend, which [loadPrLinks] answers. */
    @Synchronized
    fun unlinkPrLink(ref: PrLinkRef) {
        if (closed || remote.scope != scope) return
        try {
            remote.unlinkPullRequest(threadId, ref) { response ->
                synchronized(this) {
                    if (!accepts(response) || closed || remote.scope != scope) return@synchronized
                    val message = when (val outcome = response.outcome) {
                        is RemoteOutcome.Success -> (outcome.value as? PrLinkUnlinkResult.Refused)?.message
                        is RemoteOutcome.Failure -> outcome.message
                    }
                    if (message != null) {
                        controlMessage = message
                        publish()
                    }
                }
            }
        } catch (error: RuntimeException) {
            controlMessage = error.message ?: "Could not unlink the pull request"
            publish()
        }
    }

    @Synchronized
    fun installComposerDraft(draft: ComposerDraft?) {
        if (draft != null && draft.key != composerKey) return
        val incomingMode = draft?.runtimeMode.toRuntimeModeOrNull()
        val enteringQueuedEdit = draft?.editingOrigin != null &&
            draft.editingOrigin != composer.editingOrigin
        val installAuthoritativeText =
            (!composerHydrated && !composerHasUnacknowledgedLocalChanges) || enteringQueuedEdit
        val acknowledgesLocalChanges = draft != null &&
            draft.text == composer.draft &&
            incomingMode == pickedMode
        val focusRequest = if (enteringQueuedEdit) {
            composer.focusRequest + 1
        } else {
            composer.focusRequest
        }
        if (installAuthoritativeText && incomingMode != null) pickedMode = incomingMode
        composer = composer.copy(
            draft = if (installAuthoritativeText) draft?.text.orEmpty() else composer.draft,
            runtimeMode = if (installAuthoritativeText) {
                incomingMode ?: composer.runtimeMode
            } else {
                composer.runtimeMode
            },
            attachments = draft?.attachments.orEmpty(),
            editingOrigin = draft?.editingOrigin,
            focusRequest = focusRequest,
        )
        if (draft != null) composerHydrated = true
        if (acknowledgesLocalChanges || enteringQueuedEdit) {
            composerHasUnacknowledgedLocalChanges = false
        }
        publish()
    }

    /**
     * Show the chat's mode as the backend reports it. A live announcement
     * supersedes a pick not yet sent (the desktop changed it since); the mode
     * read with history does not, since the backend has not seen the pick.
     */
    private fun followBackendMode(mode: RuntimeMode, supersedesPick: Boolean) {
        currentThread()?.let { store = store.copy(threads = store.threads + (key to it.copy(runtimeMode = mode.wire))) }
        if (supersedesPick && pickedMode != null && !composer.modeChanging) {
            pickedMode = null
            persistComposer()
        }
        if (pickedMode == null) composer = composer.copy(runtimeMode = mode)
    }

    private fun persistComposer() {
        composerPersistence.save(
            ComposerDraft(
                key = composerKey,
                text = composer.draft,
                runtimeMode = pickedMode?.wire,
                attachments = composer.attachments,
                editingOrigin = composer.editingOrigin,
            ),
        )
    }

    private fun persistSnapshot() {
        val current = currentThread() ?: return
        runCatching { snapshotStore.save(scope.connectionId, threadId, current) }
    }

    private fun syncProfiles() {
        val provider = providerKind(currentThread()?.provider ?: providerHint)
        val options = provider?.let { NewSessionDecisions.profiles(allProfiles, it) }.orEmpty()
        profiles = profiles.copy(
            options = options,
            selectedInstanceId = currentThread()?.instanceId ?: profiles.selectedInstanceId,
        )
    }

    private fun providerKind(agentType: String?): ProviderKind? = when (agentType) {
        "claude-code", "claude" -> ProviderKind.Claude
        else -> ProviderKind.entries.firstOrNull { it.wire == agentType }
    }

    private fun <T> accepts(response: RemoteResponse<T>): Boolean =
        !closed &&
            response.key.connectionId == scope.connectionId &&
            response.key.generation == scope.generation

    private fun <T> accepts(response: RemoteResponse<T>, request: Long, current: Long): Boolean =
        request == current && accepts(response)

    private fun String?.toRuntimeModeOrNull(): RuntimeMode? =
        RuntimeMode.entries.firstOrNull { it.wire == this }

    companion object {
        const val HISTORY_LIMIT = 250L
        private const val HELD_RECOVERY_ATTEMPTS = 3
        private const val HELD_LIST_FAILURE = "Could not list queued messages: "

        private fun heldListFailure(reason: String) = HELD_LIST_FAILURE + reason
        const val IMPLEMENT_PLAN_MESSAGE = "Implement the plan you proposed."
        const val OPEN_FILE_UNSUPPORTED = "Opening changed files is not available on mobile yet."
        val ACTIVE_PROVIDER_STATUSES = setOf(
            "running",
            "working",
            "thinking",
            "connecting",
            "retrying",
        )
    }
}
