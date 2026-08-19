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
import app.switchboard.mobile.domain.remote.StartedSession
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.ThreadEventDecoder
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.domain.thread.ThreadSnapshot
import app.switchboard.mobile.domain.thread.UserMessageVisibility
import app.switchboard.mobile.platform.protocol.Cancelable
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

    fun loadSession(threadId: String, limit: Long, callback: (RemoteResponse<LoadedSession>) -> Unit)

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
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        client.respondToRequest(threadId, requestId, decision, callback)
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
}

object LoadedSessionSnapshotMapper {
    fun map(threadId: String, loaded: LoadedSession): ThreadSnapshot {
        val feed = loaded.messages.flatMap { message ->
            when (message.role.lowercase()) {
                "user" -> UserMessageVisibility.visibleText(message.content, message.displayBody)?.let { text ->
                    listOf(FeedItem.User(
                        id = "h-${message.id}",
                        text = text,
                        at = message.timestamp,
                        images = message.images,
                        pillsMeta = message.pillsMeta,
                    ))
                }.orEmpty()

                "assistant", "system" -> buildList {
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
                                input = JsonString(tool.input),
                                output = tool.output,
                                state = "done",
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
        if (loaded.truncated == true && loaded.total != null) {
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
) : AutoCloseable {
    private val key = ThreadKey(scope.connectionId, threadId)
    private val composerKey = ComposerDraftKey(scope.connectionId, threadId)
    private var store = ThreadStoreReducer.reduce(
        ThreadStoreState(
            threads = initialCached?.let { mapOf(key to it) }.orEmpty(),
        ),
        ThreadAction.Activate(scope.connectionId, scope.generation),
    )
    private var load: ThreadSessionLoad = ThreadSessionLoad.Loading(initialCached)
    private var composer = ThreadComposerState(
        draft = initialComposer?.text.orEmpty(),
        runtimeMode = initialComposer?.runtimeMode.toRuntimeModeOrNull()
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
    private var allProfiles: List<ProviderInstance> = emptyList()
    private val mutableState = MutableStateFlow(
        ThreadSessionState(load, composer, models = models, profiles = profiles),
    )
    val state = mutableState.asStateFlow()

    private var subscription: Cancelable? = null
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
        reattach(providerHint)
        refresh()
        loadSkills()
        refreshModels()
        refreshProfiles()
        remote.markRead(threadId) { /* best effort; local viewing state already cleared unread */ }
    }

    @Synchronized
    fun refresh() {
        if (closed || remote.scope != scope) return
        if (currentThread()?.awaitingReseed != true && scope !in store.reseedingConnections) {
            reduce(ThreadAction.ReplayGap(scope))
        }
        val request = ++loadRequest
        load = ThreadSessionLoad.Loading(currentThread())
        publish()
        remote.loadSession(threadId, HISTORY_LIMIT) { response -> acceptLoad(request, response) }
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
        if (composer.submitting) return ComposerSubmitResult.Busy
        val text = composer.draft.trim()
        if (text.isEmpty() && composer.attachments.isEmpty()) return ComposerSubmitResult.Empty
        composer = composer.copy(submitting = true, error = null)
        publish()
        val result = enqueueDraft(
            text = text,
            mode = composer.runtimeMode,
            attachments = composer.attachments,
            editingOrigin = composer.editingOrigin,
        )
        return when (result) {
            is EnqueueResult.Durable -> {
                addOptimistic(result.turn)
                val cleared = composerPersistence.clear(composerKey)
                composer = if (cleared) {
                    composerHasUnacknowledgedLocalChanges = false
                    composer.copy(
                        draft = "",
                        attachments = emptyList(),
                        editingOrigin = null,
                        submitting = false,
                        error = null,
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
        profiles = profiles.copy(changing = true, error = null)
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
                    is RemoteOutcome.Success -> composer.copy(interrupting = false, error = null)
                    is RemoteOutcome.Failure -> composer.copy(interrupting = false, error = outcome.message)
                }
                publish()
            }
        }
    }

    @Synchronized
    fun perform(control: ThreadSessionControl): ThreadControlOutcome = when (control) {
        is ThreadSessionControl.Approval -> requestControl(
            key = "approval:${control.requestId}",
            onPending = { pendingApprovalDecisions[control.requestId] = control.decision },
            onFinished = { pendingApprovalDecisions.remove(control.requestId) },
        ) { callback -> remote.respondToRequest(threadId, control.requestId, control.decision, callback) }

        is ThreadSessionControl.AnswerQuestion -> requestControl(
            key = "question:${control.requestId}",
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
        subscription?.cancel()
        subscription = null
        reduce(ThreadAction.SetViewing(scope.connectionId, threadId, false))
    }

    private fun acceptLoad(request: Long, response: RemoteResponse<LoadedSession>) {
        synchronized(this) {
            if (!accepts(response, request, loadRequest)) return
            when (val outcome = response.outcome) {
                is RemoteOutcome.Success -> {
                    reduce(
                        ThreadAction.InstallSnapshot(
                            scope,
                            LoadedSessionSnapshotMapper.map(threadId, outcome.value),
                        ),
                    )
                    reconcileOptimisticHistory()
                    optimisticTurns.values.forEach(::addOptimistic)
                    reduce(ThreadAction.CompleteReseed(scope))
                    load = ThreadSessionLoad.Ready(requireNotNull(currentThread()))
                    persistSnapshot()
                    reattach(outcome.value)
                }

                is RemoteOutcome.Failure -> {
                    load = ThreadSessionLoad.Failed(outcome.message, currentThread())
                }
            }
            publish()
        }
    }

    private fun reattach(loaded: LoadedSession) = reattach(loaded.meta?.agentType)

    private fun reattach(agentType: String?) {
        if (agentType == null) return
        val cwd = worktreePath ?: projectPath ?: return
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
        try {
            remote.startSession(
                StartSession(
                    threadId = threadId,
                    provider = provider,
                    cwd = cwd,
                    resumeSessionId = threadId,
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
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.QuestionAnswered -> {
                    pendingControls -= "question:${decoded.requestId}"
                    pendingQuestionRequestIds -= decoded.requestId
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
            reduce(ThreadAction.Runtime(ScopedThreadEvent(eventScope, null, event)))
            val providerEvent = known?.payload as?
                app.switchboard.mobile.domain.thread.ThreadEventPayload.SessionProvider
            if (providerEvent != null) {
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
        mode: RuntimeMode,
        attachments: List<ComposerAttachment> = emptyList(),
        editingOrigin: String? = null,
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
                runtimeMode = mode.wire,
                createdAtMs = clock.nowMs(),
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
            controlMessage = controlMessage,
            skills = skills,
            models = models,
            profiles = profiles,
            archive = archive,
            pendingActions = ThreadPendingActions(
                approvalDecisions = pendingApprovalDecisions.toMap(),
                questionRequestIds = pendingQuestionRequestIds.toSet(),
                planIds = pendingPlanOrigins.keys.toSet(),
            ),
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
            incomingMode == composer.runtimeMode
        val focusRequest = if (enteringQueuedEdit) {
            composer.focusRequest + 1
        } else {
            composer.focusRequest
        }
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

    private fun persistComposer() {
        composerPersistence.save(
            ComposerDraft(
                key = composerKey,
                text = composer.draft,
                runtimeMode = composer.runtimeMode.wire,
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
        const val IMPLEMENT_PLAN_MESSAGE = "Implement the plan you proposed."
        const val OPEN_FILE_UNSUPPORTED = "Opening changed files is not available on mobile yet."
        private val ACTIVE_PROVIDER_STATUSES = setOf(
            "running",
            "working",
            "thinking",
            "connecting",
            "retrying",
        )
    }
}
