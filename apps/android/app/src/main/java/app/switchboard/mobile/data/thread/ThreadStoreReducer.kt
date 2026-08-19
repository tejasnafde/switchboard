package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.thread.DriftSuggestion
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.SpendBlock
import app.switchboard.mobile.domain.thread.ThreadEventPayload
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.domain.thread.ThreadRuntimeEvent
import app.switchboard.mobile.domain.thread.ThreadSnapshot
import app.switchboard.mobile.domain.thread.UserMessageVisibility
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject

data class ThreadKey(
    val connectionId: String,
    val threadId: String,
)

data class ScopedThreadEvent(
    val scope: ThreadEventScope,
    val sequence: Long?,
    val event: ThreadRuntimeEvent,
    val rawPayloads: List<JsonObject> = listOf(event.raw),
)

data class ThreadState(
    val feed: List<FeedItem> = emptyList(),
    val status: String = "connecting",
    val runtimeMode: String = "sandbox",
    val provider: String? = null,
    val instanceId: String? = null,
    val instanceName: String? = null,
    val sessionId: String? = null,
    val usedTokens: Long? = null,
    val maxTokens: Long? = null,
    val costUsd: Double? = null,
    val resolvedModel: String? = null,
    val availableVariants: List<String> = emptyList(),
    val currentVariant: String? = null,
    val lastTurnDurationMs: Long? = null,
    val unread: Int = 0,
    val drift: DriftSuggestion? = null,
    val spendBlock: SpendBlock? = null,
    val eventJournal: List<ScopedThreadEvent> = emptyList(),
    val awaitingReseed: Boolean = false,
    val bufferedEvents: List<ScopedThreadEvent> = emptyList(),
)

data class ThreadStoreState(
    val generations: Map<String, Long> = emptyMap(),
    val threads: Map<ThreadKey, ThreadState> = emptyMap(),
    val reseedingConnections: Set<ThreadEventScope> = emptySet(),
    val viewingThreads: Set<ThreadKey> = emptySet(),
) {
    fun thread(connectionId: String, threadId: String): ThreadState? =
        threads[ThreadKey(connectionId, threadId)]
}

sealed interface ThreadAction {
    data class Activate(val connectionId: String, val generation: Long) : ThreadAction
    data class Runtime(val scopedEvent: ScopedThreadEvent) : ThreadAction
    data class ReplayGap(val scope: ThreadEventScope) : ThreadAction
    data class InstallSnapshot(val scope: ThreadEventScope, val snapshot: ThreadSnapshot) : ThreadAction
    data class CompleteReseed(val scope: ThreadEventScope) : ThreadAction
    data class SetViewing(val connectionId: String, val threadId: String, val viewing: Boolean) : ThreadAction
}

object ThreadEventCoalescer {
    fun coalesce(events: List<ScopedThreadEvent>): List<ScopedThreadEvent> {
        val result = mutableListOf<ScopedThreadEvent>()
        events.forEach { next ->
            val previous = result.lastOrNull()
            val merged = if (previous == null) null else mergeContent(previous, next)
            if (merged == null) result += next else result[result.lastIndex] = merged
        }
        return result
    }

    private fun mergeContent(
        first: ScopedThreadEvent,
        second: ScopedThreadEvent,
    ): ScopedThreadEvent? {
        if (first.scope != second.scope || first.event.threadId != second.event.threadId) return null
        val firstKnown = first.event as? ThreadRuntimeEvent.Known ?: return null
        val secondKnown = second.event as? ThreadRuntimeEvent.Known ?: return null
        val a = firstKnown.payload as? ThreadEventPayload.Content ?: return null
        val b = secondKnown.payload as? ThreadEventPayload.Content ?: return null
        if (a.messageId != b.messageId || a.streamKind != b.streamKind) return null
        val merged = if (b.append) {
            b.copy(text = a.text + b.text, append = a.append)
        } else {
            b
        }
        return second.copy(
            event = secondKnown.copy(payload = merged),
            rawPayloads = first.rawPayloads + second.rawPayloads,
        )
    }
}

object ThreadStoreReducer {
    fun reduce(state: ThreadStoreState, action: ThreadAction): ThreadStoreState =
        when (action) {
            is ThreadAction.Activate -> activate(state, action)
            is ThreadAction.Runtime -> runtime(state, action.scopedEvent)
            is ThreadAction.ReplayGap -> replayGap(state, action.scope)
            is ThreadAction.InstallSnapshot -> installSnapshot(state, action.scope, action.snapshot)
            is ThreadAction.CompleteReseed -> completeReseed(state, action.scope)
            is ThreadAction.SetViewing -> setViewing(state, action)
        }

    private fun activate(state: ThreadStoreState, action: ThreadAction.Activate): ThreadStoreState {
        val previous = state.generations[action.connectionId]
        if (previous != null && action.generation < previous) return state
        if (previous == action.generation) return state
        val threads = if (previous == null) {
            state.threads
        } else {
            state.threads.mapValues { (key, thread) ->
                if (key.connectionId == action.connectionId) {
                    thread.copy(awaitingReseed = false, bufferedEvents = emptyList())
                } else {
                    thread
                }
            }
        }
        return state.copy(
            generations = state.generations + (action.connectionId to action.generation),
            threads = threads,
            reseedingConnections = state.reseedingConnections.filterNotTo(mutableSetOf()) {
                it.connectionId == action.connectionId
            },
        )
    }

    private fun runtime(state: ThreadStoreState, scoped: ScopedThreadEvent): ThreadStoreState {
        if (state.generations[scoped.scope.connectionId] != scoped.scope.generation) return state
        val key = ThreadKey(scoped.scope.connectionId, scoped.event.threadId)
        val current = state.threads[key]
        val mustWaitForSnapshot = current?.awaitingReseed == true ||
            (current == null && scoped.scope in state.reseedingConnections)
        val base = current ?: ThreadState(awaitingReseed = mustWaitForSnapshot)
        val next = if (mustWaitForSnapshot) {
            base.copy(
                bufferedEvents = ThreadEventCoalescer.coalesce(base.bufferedEvents + scoped),
            )
        } else {
            applyEvent(base, scoped, key in state.viewingThreads)
        }
        return state.copy(threads = state.threads + (key to next))
    }

    private fun replayGap(state: ThreadStoreState, scope: ThreadEventScope): ThreadStoreState {
        if (state.generations[scope.connectionId] != scope.generation) return state
        return state.copy(
            threads = state.threads.mapValues { (key, thread) ->
                if (key.connectionId == scope.connectionId) {
                    thread.copy(awaitingReseed = true, bufferedEvents = emptyList())
                } else {
                    thread
                }
            },
            reseedingConnections = state.reseedingConnections + scope,
        )
    }

    private fun installSnapshot(
        state: ThreadStoreState,
        scope: ThreadEventScope,
        snapshot: ThreadSnapshot,
    ): ThreadStoreState {
        if (state.generations[scope.connectionId] != scope.generation) return state
        val key = ThreadKey(scope.connectionId, snapshot.threadId)
        val current = state.threads[key]
        if (current == null) {
            return state.copy(
                threads = state.threads + (
                    key to ThreadState(
                        feed = snapshot.feed,
                        awaitingReseed = false,
                    )
                ),
            )
        }
        if (!current.awaitingReseed) {
            if (current.feed.isNotEmpty()) return state
            return state.copy(threads = state.threads + (key to current.copy(feed = snapshot.feed)))
        }

        var reseeded = current.copy(
            feed = snapshot.feed,
            eventJournal = emptyList(),
            awaitingReseed = false,
            bufferedEvents = emptyList(),
        )
        current.bufferedEvents.forEach {
            reseeded = applyEvent(reseeded, it, key in state.viewingThreads)
        }
        return state.copy(threads = state.threads + (key to reseeded))
    }

    private fun completeReseed(
        state: ThreadStoreState,
        scope: ThreadEventScope,
    ): ThreadStoreState {
        if (state.generations[scope.connectionId] != scope.generation) return state
        val stillWaiting = state.threads.any { (key, thread) ->
            key.connectionId == scope.connectionId && thread.awaitingReseed
        }
        if (stillWaiting) return state
        return state.copy(reseedingConnections = state.reseedingConnections - scope)
    }

    private fun setViewing(
        state: ThreadStoreState,
        action: ThreadAction.SetViewing,
    ): ThreadStoreState {
        val key = ThreadKey(action.connectionId, action.threadId)
        val viewing = if (action.viewing) state.viewingThreads + key else state.viewingThreads - key
        val thread = state.threads[key]
        val threads = if (action.viewing && thread != null && thread.unread != 0) {
            state.threads + (key to thread.copy(unread = 0))
        } else {
            state.threads
        }
        return state.copy(viewingThreads = viewing, threads = threads)
    }

    private fun applyEvent(
        thread: ThreadState,
        scoped: ScopedThreadEvent,
        isViewing: Boolean,
    ): ThreadState {
        val withJournal = thread.copy(eventJournal = thread.eventJournal + scoped)
        val known = scoped.event as? ThreadRuntimeEvent.Known
            ?: return appendRawNotice(withJournal, scoped)
        return when (val event = known.payload) {
            is ThreadEventPayload.Content -> content(withJournal, event, isViewing)
            is ThreadEventPayload.UserMessage -> {
                val text = UserMessageVisibility.visibleText(event.text, event.displayBody)
                    ?: return withJournal
                withJournal.copy(
                    feed = upsert(
                        withJournal.feed,
                        FeedItem.User(
                            "remote_${event.origin ?: event.at}",
                            text,
                            event.at,
                            event.images,
                        ),
                    ),
                )
            }
            is ThreadEventPayload.ToolStarted -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Tool("t-${event.toolId}", event.toolId, event.toolName, event.input, state = "running"),
                ),
            )
            is ThreadEventPayload.ToolCompleted -> {
                val id = "t-${event.toolId}"
                val existing = withJournal.feed.firstOrNull { it.id == id } as? FeedItem.Tool
                withJournal.copy(
                    feed = upsert(
                        withJournal.feed,
                        (existing ?: FeedItem.Tool(id, event.toolId, "Unknown tool", JsonNull, state = "done"))
                            .copy(output = event.output, state = "done"),
                    ),
                )
            }
            is ThreadEventPayload.ToolDenied -> withJournal.copy(
                feed = withJournal.feed + FeedItem.Denial(
                    eventId(scoped, "denial"), event.toolName, event.reason, event.mode,
                ),
            )
            is ThreadEventPayload.RequestOpened -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Approval(
                        "a-${event.requestId}", event.requestId, event.toolName,
                        event.detail, event.requestType, "pending",
                    ),
                ),
            )
            is ThreadEventPayload.RequestClosed -> {
                val id = "a-${event.requestId}"
                val existing = withJournal.feed.firstOrNull { it.id == id } as? FeedItem.Approval
                withJournal.copy(
                    feed = upsert(
                        withJournal.feed,
                        (existing ?: FeedItem.Approval(id, event.requestId, "Unknown tool", "", "tool", event.decision))
                            .copy(state = event.decision),
                    ),
                )
            }
            is ThreadEventPayload.TurnCompleted -> finishTurn(withJournal, event)
            is ThreadEventPayload.TurnRetrying -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Retry("r-${event.turnId}", event.turnId, event.message, true),
                ),
            )
            is ThreadEventPayload.Error -> withJournal.copy(
                feed = withJournal.feed + FeedItem.Error(eventId(scoped, "error"), event.message, event.turnId),
                status = "error",
            )
            is ThreadEventPayload.Status -> withJournal.copy(
                status = event.status,
                feed = if (event.status == "running") withJournal.feed else stopRetries(withJournal.feed),
            )
            is ThreadEventPayload.Session -> withJournal.copy(sessionId = event.sessionId)
            is ThreadEventPayload.SessionProvider -> withJournal.copy(
                provider = event.provider,
                instanceId = event.instanceId,
                instanceName = event.instanceName,
            )
            is ThreadEventPayload.ContextWindow -> withJournal.copy(
                usedTokens = event.usedTokens,
                maxTokens = event.maxTokens ?: withJournal.maxTokens,
                resolvedModel = event.model ?: withJournal.resolvedModel,
                costUsd = event.costUsd ?: withJournal.costUsd,
            )
            is ThreadEventPayload.ModelVariants -> withJournal.copy(
                resolvedModel = event.modelId,
                availableVariants = event.availableVariants,
                currentVariant = event.currentVariant,
            )
            is ThreadEventPayload.PlanProposed -> withJournal.copy(
                feed = upsert(withJournal.feed, FeedItem.Plan("p-${event.planId}", event.planId, event.markdown)),
            )
            is ThreadEventPayload.QuestionAsked -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Question("q-${event.requestId}", event.requestId, event.questions),
                ),
            )
            is ThreadEventPayload.QuestionAnswered -> {
                val id = "q-${event.requestId}"
                val existing = withJournal.feed.firstOrNull { it.id == id } as? FeedItem.Question
                withJournal.copy(
                    feed = upsert(
                        withJournal.feed,
                        (existing ?: FeedItem.Question(id, event.requestId, emptyList())).copy(answers = event.answers),
                    ),
                )
            }
            is ThreadEventPayload.FileEdited -> withJournal.copy(
                feed = appendReplacing(
                    withJournal.feed,
                    FeedItem.FileEdit(
                        "f-${event.fileEditId}", event.fileEditId, event.repoRoot, event.relPath,
                        event.changeKind, event.oldContent, event.newContent,
                    ),
                ),
            )
            is ThreadEventPayload.WorktreeDrift -> withJournal.copy(
                drift = DriftSuggestion(event.worktreePath, event.branch),
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Drift("drift", event.worktreePath, event.branch),
                ),
            )
            is ThreadEventPayload.SpendBlocked -> withJournal.copy(
                spendBlock = SpendBlock(event.instanceId, event.model, event.reason, event.scope, event.resetsAtMs),
                feed = upsert(
                    withJournal.feed,
                    FeedItem.SpendBlocked(
                        "spend:${event.instanceId}:${event.model}", event.instanceId, event.model,
                        event.reason, event.scope, event.resetsAtMs,
                    ),
                ),
            )
            is ThreadEventPayload.ThreadRead -> withJournal.copy(unread = 0)
            is ThreadEventPayload.PeerMessage -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Peer(
                        if (event.direction == "sent") "peer_${event.messageId}" else event.messageId,
                        event.direction, event.initiator,
                        event.messageId, event.peerThreadId, event.peerLabel, event.text, event.at,
                    ),
                ),
            )
            is ThreadEventPayload.TodoUpdated -> withJournal.copy(
                feed = upsert(withJournal.feed, FeedItem.Todo("todo-${event.todoId}", event.todoId, event.items)),
            )
        }
    }

    private fun content(
        thread: ThreadState,
        event: ThreadEventPayload.Content,
        isViewing: Boolean,
    ): ThreadState {
        val id = "m-${event.messageId}-${event.streamKind}"
        val existing = thread.feed.firstOrNull { it.id == id } as? FeedItem.Text
        val text = if (event.append) (existing?.text ?: "") + event.text else event.text
        return thread.copy(
            feed = upsert(
                thread.feed,
                (existing ?: FeedItem.Text(id, event.messageId, "", event.streamKind)).copy(text = text),
            ),
            unread = if (
                existing == null && event.streamKind == "assistant" && !isViewing
            ) {
                thread.unread + 1
            } else {
                thread.unread
            },
        )
    }

    private fun finishTurn(
        thread: ThreadState,
        event: ThreadEventPayload.TurnCompleted,
    ): ThreadState {
        val lastAssistant = thread.feed.indexOfLast { it is FeedItem.Text && it.stream == "assistant" }
        val feed = thread.feed.mapIndexed { index, item ->
            when (item) {
                is FeedItem.Text -> item.copy(
                    done = true,
                    durationMs = if (index == lastAssistant) event.durationMs else item.durationMs,
                )
                is FeedItem.Tool -> if (item.state == "running") item.copy(state = "done") else item
                is FeedItem.Retry -> item.copy(active = false)
                else -> item
            }
        }
        return thread.copy(
            feed = feed,
            status = "idle",
            usedTokens = event.usedTokens ?: thread.usedTokens,
            maxTokens = event.maxTokens ?: thread.maxTokens,
            costUsd = event.costUsd ?: thread.costUsd,
            lastTurnDurationMs = event.durationMs,
        )
    }

    private fun appendRawNotice(thread: ThreadState, scoped: ScopedThreadEvent): ThreadState {
        val event = scoped.event
        val text = when (event) {
            is ThreadRuntimeEvent.Malformed -> "Malformed ${event.type}: ${event.error}"
            is ThreadRuntimeEvent.Extension -> "Unsupported runtime event: ${event.type}"
            is ThreadRuntimeEvent.Known -> error("Known event cannot be a raw notice")
        }
        return thread.copy(
            feed = thread.feed + FeedItem.RawNotice(
                eventId(scoped, "raw"), event.type, text, event.raw,
            ),
        )
    }

    private fun stopRetries(feed: List<FeedItem>): List<FeedItem> = feed.map {
        if (it is FeedItem.Retry) it.copy(active = false) else it
    }

    private fun upsert(feed: List<FeedItem>, item: FeedItem): List<FeedItem> {
        val index = feed.indexOfFirst { it.id == item.id }
        if (index < 0) return feed + item
        return feed.toMutableList().also { it[index] = item }
    }

    private fun appendReplacing(feed: List<FeedItem>, item: FeedItem): List<FeedItem> =
        feed.filterNot { it.id == item.id } + item

    private fun eventId(scoped: ScopedThreadEvent, prefix: String): String =
        scoped.sequence?.let { "$prefix:seq:$it" }
            ?: "$prefix:${scoped.event.type}:${scoped.event.raw.hashCode()}"
}
