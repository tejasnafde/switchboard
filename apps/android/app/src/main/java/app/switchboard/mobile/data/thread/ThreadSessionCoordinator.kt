package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.remote.AnswerQuestion
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.remote.MarkReadResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.ThreadEventDecoder
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.domain.thread.ThreadSnapshot
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.protocol.RuntimeEventPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

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
)

data class ThreadSessionState(
    val load: ThreadSessionLoad,
    val composer: ThreadComposerState,
    val controlMessage: String? = null,
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
}

fun interface ThreadSessionClock {
    fun nowMs(): Long
}

interface ThreadSessionRemote {
    val scope: ThreadEventScope

    fun subscribe(listener: (ThreadEventScope, RuntimeEventPayload) -> Unit): Cancelable

    fun loadSession(threadId: String, callback: (RemoteResponse<LoadedSession>) -> Unit)

    fun markRead(threadId: String, callback: (RemoteResponse<MarkReadResult>) -> Unit)

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

    override fun loadSession(threadId: String, callback: (RemoteResponse<LoadedSession>) -> Unit) {
        client.loadSession(threadId, callback = callback)
    }

    override fun markRead(threadId: String, callback: (RemoteResponse<MarkReadResult>) -> Unit) {
        client.markRead(threadId, callback)
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

    override fun interrupt(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit) {
        client.interrupt(threadId, callback)
    }
}

object LoadedSessionSnapshotMapper {
    fun map(threadId: String, loaded: LoadedSession): ThreadSnapshot {
        val feed = loaded.messages.map { message ->
            when (message.role.lowercase()) {
                "user" -> FeedItem.User(
                    id = "h-${message.id}",
                    text = message.content,
                    at = message.timestamp,
                )

                "assistant", "system" -> FeedItem.Text(
                    id = "h-${message.id}",
                    messageId = message.id,
                    text = message.content,
                    stream = "assistant",
                    done = true,
                )

                else -> FeedItem.RawNotice(
                    id = "h-${message.id}",
                    eventType = "history.${message.role}",
                    text = message.content,
                    raw = message.raw,
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
                    raw = loaded.raw,
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
) : AutoCloseable {
    private val key = ThreadKey(scope.connectionId, threadId)
    private var store = ThreadStoreReducer.reduce(
        ThreadStoreState(
            threads = initialCached?.let { mapOf(key to it) }.orEmpty(),
        ),
        ThreadAction.Activate(scope.connectionId, scope.generation),
    )
    private var load: ThreadSessionLoad = ThreadSessionLoad.Loading(initialCached)
    private var composer = ThreadComposerState(
        runtimeMode = initialCached?.runtimeMode.toRuntimeModeOrNull() ?: RuntimeMode.Sandbox,
    )
    private var controlMessage: String? = null
    private val mutableState = MutableStateFlow(ThreadSessionState(load, composer))
    val state = mutableState.asStateFlow()

    private var subscription: Cancelable? = null
    private var started = false
    private var closed = false
    private var loadRequest = 0L
    private var modeRequest = 0L
    private val pendingControls = mutableSetOf<String>()
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
        refresh()
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
        remote.loadSession(threadId) { response -> acceptLoad(request, response) }
    }

    @Synchronized
    fun onReplayGap(eventScope: ThreadEventScope) {
        if (closed || eventScope != scope) return
        reduce(ThreadAction.ReplayGap(eventScope))
        refresh()
    }

    @Synchronized
    fun currentThread(): ThreadState? = store.thread(scope.connectionId, threadId)

    @Synchronized
    fun updateDraft(text: String) {
        composer = composer.copy(draft = text, error = null)
        publish()
    }

    @Synchronized
    fun submit(): ComposerSubmitResult {
        if (composer.submitting) return ComposerSubmitResult.Busy
        val text = composer.draft.trim()
        if (text.isEmpty()) return ComposerSubmitResult.Empty
        composer = composer.copy(submitting = true, error = null)
        publish()
        val result = enqueueDraft(text, composer.runtimeMode)
        return when (result) {
            is EnqueueResult.Durable -> {
                addOptimistic(result.turn)
                composer = composer.copy(draft = "", submitting = false, error = null)
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
                publish()
            }
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
        is ThreadSessionControl.Approval -> requestControl("approval:${control.requestId}") { callback ->
            remote.respondToRequest(threadId, control.requestId, control.decision, callback)
        }

        is ThreadSessionControl.AnswerQuestion -> requestControl("question:${control.requestId}") { callback ->
            remote.answerQuestion(threadId, control.requestId, control.answers, callback)
        }

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
                }

                is RemoteOutcome.Failure -> {
                    load = ThreadSessionLoad.Failed(outcome.message, currentThread())
                }
            }
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
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.RequestClosed ->
                    pendingControls -= "approval:${decoded.requestId}"
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.QuestionAnswered ->
                    pendingControls -= "question:${decoded.requestId}"
                is app.switchboard.mobile.domain.thread.ThreadEventPayload.UserMessage -> {
                    val origin = decoded.origin
                    if (origin != null) {
                        optimisticTurns.remove(origin)
                        pendingPlanOrigins.entries.removeAll { it.value == origin }
                    }
                }
                else -> Unit
            }
            reduce(ThreadAction.Runtime(ScopedThreadEvent(eventScope, null, event)))
            load = when (val current = load) {
                is ThreadSessionLoad.Loading -> ThreadSessionLoad.Loading(currentThread())
                is ThreadSessionLoad.Failed -> current.copy(cached = currentThread())
                is ThreadSessionLoad.Ready -> current.copy(thread = requireNotNull(currentThread()))
            }
            publish()
        }
    }

    private fun requestControl(
        key: String,
        request: (((RemoteResponse<CommandBody>) -> Unit) -> Unit),
    ): ThreadControlOutcome {
        if (closed || remote.scope != scope) return ThreadControlOutcome.Failed("Connection scope changed")
        if (!pendingControls.add(key)) return ThreadControlOutcome.Busy
        controlMessage = null
        publish()
        try {
            request { response ->
                synchronized(this) {
                    if (!accepts(response)) return@synchronized
                    val failure = response.outcome as? RemoteOutcome.Failure
                    if (failure != null) {
                        pendingControls -= key
                        controlMessage = failure.message
                        publish()
                    }
                }
            }
        } catch (error: RuntimeException) {
            pendingControls -= key
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
                ThreadControlOutcome.Durable(result.turn)
            }
            is EnqueueResult.AttachmentFailure -> controlFailed(result.reason)
            is EnqueueResult.StorageFailure -> controlFailed(result.reason)
        }
    }

    private fun enqueueDraft(text: String, mode: RuntimeMode): EnqueueResult = try {
        enqueue.enqueue(
            OutgoingTurnDraft(
                connectionId = scope.connectionId,
                threadId = threadId,
                text = text,
                attachments = emptyList(),
                runtimeMode = mode.wire,
                createdAtMs = clock.nowMs(),
            ),
        )
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
        val item = FeedItem.User(turn.bubbleId, turn.text, turn.createdAtMs)
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
        mutableState.value = ThreadSessionState(load, composer, controlMessage)
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
        const val IMPLEMENT_PLAN_MESSAGE = "Implement the plan you proposed."
        const val OPEN_FILE_UNSUPPORTED = "Opening changed files is not available on mobile yet."
    }
}
