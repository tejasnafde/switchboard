package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.remote.SessionMeta
import app.switchboard.mobile.domain.thread.DriftSuggestion
import app.switchboard.mobile.domain.thread.EXPIRED_EVENT_TYPE
import app.switchboard.mobile.domain.thread.ExpiredRequests
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.PeerUndelivered
import app.switchboard.mobile.domain.thread.SpendBlock
import app.switchboard.mobile.domain.thread.SyntheticUserMessage
import app.switchboard.mobile.domain.thread.SystemMarkers
import app.switchboard.mobile.domain.thread.ThreadEventPayload
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.domain.thread.ThreadRuntimeEvent
import app.switchboard.mobile.domain.thread.ThreadSnapshot
import app.switchboard.mobile.domain.thread.UserMessageVisibility
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

data class ThreadKey(
    val connectionId: String,
    val threadId: String,
)

data class ScopedThreadEvent(
    val scope: ThreadEventScope,
    val sequence: Long?,
    val event: ThreadRuntimeEvent,
    val rawPayloads: List<JsonObject> = listOf(event.raw),
    /** Wall-clock arrival time, stamped by the caller (mirrors chat.ts's
     *  `Date.now()` on turn.completed) so the reducer stays a pure function
     *  of its inputs instead of reading the clock itself. Only turn.completed
     *  consumes this, to drive the compaction-offer banner's staleness check. */
    val nowMs: Long = 0L,
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
    /** When the agent last finished a turn (wall clock). Mirrors
     *  ThreadState.lastTurnAt in apps/mobile/src/stores/chat.ts - drives the
     *  compaction-offer banner's staleness check. */
    val lastTurnAt: Long? = null,
    val unread: Int = 0,
    val drift: DriftSuggestion? = null,
    val spendBlock: SpendBlock? = null,
    /** Message ids (their user row ids) the backend holds until the running turn ends. */
    val heldTurns: Set<String> = emptySet(),
    /** The queue waits for Resume after a failed or usage-limited turn. */
    val queueHeld: Boolean = false,
    /** Held rows that could not start, with why. Cancel takes them back. */
    val failedHeld: Map<String, String> = emptyMap(),
    val eventJournal: List<ScopedThreadEvent> = emptyList(),
    val eventArrival: Long = 0,
    val lastSequence: Long? = null,
    val awaitingReseed: Boolean = false,
    val historyLoaded: Boolean = false,
    val historyMeta: SessionMeta? = null,
    val nextBeforeId: String? = null,
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
    /** Replace the held messages with what the backend lists (open, reconnect, resume gap). */
    data class SeedHeldTurns(
        val connectionId: String,
        val threadId: String,
        val messageIds: Set<String>,
        val queueHeld: Boolean = false,
        val failed: Map<String, String> = emptyMap(),
    ) : ThreadAction
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
            is ThreadAction.SeedHeldTurns -> {
                val key = ThreadKey(action.connectionId, action.threadId)
                val thread = state.threads[key] ?: ThreadState()
                state.copy(
                    threads = state.threads + (
                        key to thread.copy(heldTurns = action.messageIds, queueHeld = action.queueHeld, failedHeld = action.failed)
                    ),
                )
            }
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
        if (scoped.sequence != null && current?.lastSequence != null && scoped.sequence <= current.lastSequence) return state
        val mustWaitForSnapshot = current?.awaitingReseed == true ||
            (current == null && scoped.scope in state.reseedingConnections)
        val base = current ?: ThreadState(awaitingReseed = mustWaitForSnapshot)
        val next = if (mustWaitForSnapshot) {
            applyEvent(base, scoped, key in state.viewingThreads).copy(
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
                    thread.copy(awaitingReseed = true, historyLoaded = false, lastSequence = null, bufferedEvents = emptyList())
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
        current.bufferedEvents.forEach { buffered ->
            val contentEvent = (buffered.event as? ThreadRuntimeEvent.Known)?.payload as? ThreadEventPayload.Content
            val live = contentEvent?.let { event -> current.feed.filterIsInstance<FeedItem.Text>()
                .firstOrNull { it.messageId == event.messageId && it.stream == event.streamKind } }
            val history = contentEvent?.let { event -> snapshot.feed.filterIsInstance<FeedItem.Text>()
                .firstOrNull { it.messageId == event.messageId && it.stream == event.streamKind } }
            if (live != null) {
                val text = if (history?.text?.contains(live.text) == true) history.text else live.text
                reseeded = content(reseeded, contentEvent.copy(text = text, append = false), key in state.viewingThreads)
            } else reseeded = applyEvent(reseeded, buffered, key in state.viewingThreads)
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
        val withJournal = thread.copy(eventJournal = thread.eventJournal + scoped, eventArrival = thread.eventArrival + scoped.rawPayloads.size, lastSequence = scoped.sequence ?: thread.lastSequence)
        val known = scoped.event as? ThreadRuntimeEvent.Known
            ?: return appendRawNotice(withJournal, scoped)
        return when (val event = known.payload) {
            is ThreadEventPayload.Content -> content(withJournal, event, isViewing)
            is ThreadEventPayload.UserMessage -> {
                // The backend's context handoff marker, same row as the history load.
                val marker = event.handoffMarker?.let {
                    FeedItem.RawNotice("h-${it.id}", SystemMarkers.ROW_EVENT_TYPE, it.text, JsonObject(linkedMapOf()))
                }
                val withMarker = if (marker == null || withJournal.feed.any { it.id == marker.id }) {
                    withJournal
                } else {
                    withJournal.copy(feed = withJournal.feed + marker)
                }
                val text = UserMessageVisibility.visibleText(event.text, event.displayBody)
                // Context-only text is hidden, but images sent with it still show.
                if (text == null && event.images.isEmpty()) return withMarker
                withMarker.copy(
                    feed = upsert(
                        withMarker.feed,
                        FeedItem.User(
                            "remote_${event.origin ?: event.at}",
                            text.orEmpty(),
                            event.at,
                            event.images,
                            event.pillsMeta,
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
                if (existing == null) {
                    withJournal
                } else {
                    withJournal.copy(
                        feed = upsert(
                            withJournal.feed,
                            existing.copy(output = event.output, state = "done"),
                        ),
                    )
                }
            }
            is ThreadEventPayload.ToolDenied -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Denial(
                        eventId(scoped, "denial", withJournal.eventArrival), event.toolName, event.reason, event.mode,
                    ),
                ),
            )
            is ThreadEventPayload.RequestOpened -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Approval(
                        "a-${event.requestId}", event.requestId, event.toolName,
                        event.detail, event.requestType, "pending", event.hostWrite,
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
            // An open card becomes a notice under the same id, so nothing offers
            // buttons that answer nothing. An answered card is left as it is.
            is ThreadEventPayload.RequestExpired -> withJournal.copy(
                feed = withJournal.feed.map { item ->
                    when {
                        item is FeedItem.Approval && item.requestId == event.requestId && item.state == "pending" ->
                            FeedItem.RawNotice(item.id, EXPIRED_EVENT_TYPE, ExpiredRequests.notice(approval = true, event.reason), scoped.event.raw)
                        item is FeedItem.Question && item.requestId == event.requestId && item.answers == null ->
                            FeedItem.RawNotice(item.id, EXPIRED_EVENT_TYPE, ExpiredRequests.notice(approval = false, event.reason), scoped.event.raw)
                        else -> item
                    }
                },
            )
            is ThreadEventPayload.TurnCompleted -> finishTurn(withJournal, event, scoped.nowMs)
            is ThreadEventPayload.TurnRetrying -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Retry("r-${event.turnId}", event.turnId, event.message, true),
                ),
            )
            is ThreadEventPayload.Error -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.Error(eventId(scoped, "error", withJournal.eventArrival), event.message, event.turnId),
                ),
                status = "error",
            )
            is ThreadEventPayload.Status -> withJournal.copy(
                status = event.status,
                // A session that stopped or died holds nothing any more.
                // An error keeps them: the backend holds the queue after a
                // failed turn and announces each message it drops.
                heldTurns = if (event.status == "stopped") emptySet() else withJournal.heldTurns,
                queueHeld = event.status != "stopped" && withJournal.queueHeld,
                failedHeld = if (event.status == "stopped") emptyMap() else withJournal.failedHeld,
                feed = if (event.status == "running") withJournal.feed else stopRetries(withJournal.feed),
            )
            is ThreadEventPayload.Session -> withJournal.copy(sessionId = event.sessionId)
            is ThreadEventPayload.SessionProvider -> withJournal.copy(
                provider = event.provider,
                instanceId = event.instanceId,
                instanceName = event.instanceName,
                runtimeMode = event.runtimeMode ?: withJournal.runtimeMode,
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
            is ThreadEventPayload.ModelUnavailable -> withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.RawNotice(
                        eventId(scoped, "model-unavailable", withJournal.eventArrival),
                        "model.unavailable",
                        "${event.model} is not available on this account any more. This chat now uses the default model.",
                        scoped.event.raw,
                    ),
                ),
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
            // Same text as the transcript line a reload shows, so it splits into the same row.
            // installSnapshot replays buffered events over history, so skip one the history already shows.
            is ThreadEventPayload.TaskNotification -> if (historyShowsTaskNotification(withJournal.feed, event)) {
                withJournal
            } else withJournal.copy(
                feed = upsert(
                    withJournal.feed,
                    FeedItem.User(
                        event.messageId,
                        SyntheticUserMessage.taskNotificationText(event.taskId, event.status, event.summary, event.outputFile),
                        event.at,
                        fromTranscript = true,
                    ),
                ),
            )
            is ThreadEventPayload.TurnQueued -> withJournal.copy(
                heldTurns = withJournal.heldTurns + event.messageId,
                queueHeld = event.held,
            )
            is ThreadEventPayload.TurnQueueHeld -> withJournal.copy(queueHeld = event.held)
            // It could not start: back on its row, marked, until Cancel.
            is ThreadEventPayload.TurnDequeued -> if (event.reason == "failed") {
                withJournal.copy(
                    heldTurns = withJournal.heldTurns + event.messageId,
                    failedHeld = withJournal.failedHeld + (event.messageId to (event.error ?: "It could not start.")),
                )
            } else withJournal.copy(
                // A message taken back or dropped never reached the agent (the
                // backend stored a not-sent row instead). The row can be live
                // (`remote_x`) or from history (`h-remote_x`).
                heldTurns = withJournal.heldTurns - event.messageId,
                failedHeld = withJournal.failedHeld - event.messageId,
                feed = if (event.reason == "cancelled" || event.reason == "dropped") {
                    withJournal.feed.filterNot { it is FeedItem.User && feedIdentity(it) == event.messageId }
                } else {
                    withJournal.feed
                },
            )
        }
    }

    private fun content(
        thread: ThreadState,
        event: ThreadEventPayload.Content,
        isViewing: Boolean,
    ): ThreadState {
        val id = "m-${event.messageId}-${event.streamKind}"
        val existing = thread.feed.filterIsInstance<FeedItem.Text>()
            .firstOrNull { it.messageId == event.messageId && it.stream == event.streamKind }
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
        nowMs: Long,
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
            lastTurnAt = nowMs,
        )
    }

    private fun appendRawNotice(thread: ThreadState, scoped: ScopedThreadEvent): ThreadState {
        val event = scoped.event
        // A fork's summary card that was discarded: its row goes away.
        if (event is ThreadRuntimeEvent.Extension && event.type == MERGE_BACK_ROW_EVENT && event.raw.values["content"] == JsonNull) {
            val messageId = (event.raw.values["messageId"] as? JsonString)?.value ?: return thread
            return thread.copy(feed = thread.feed.filterNot { it.id == "h-$messageId" })
        }
        if (event is ThreadRuntimeEvent.Extension) systemRow(event)?.let { row ->
            return thread.copy(feed = upsert(thread.feed, row))
        }
        val text = when (event) {
            is ThreadRuntimeEvent.Malformed -> "Malformed ${event.type}: ${event.error}"
            is ThreadRuntimeEvent.Extension -> "Unsupported runtime event: ${event.type}"
            is ThreadRuntimeEvent.Known -> error("Known event cannot be a raw notice")
        }
        return thread.copy(
            feed = upsert(
                thread.feed,
                FeedItem.RawNotice(eventId(scoped, "raw", thread.eventArrival), event.type, text, event.raw),
            ),
        )
    }

    /**
     * The events that carry a stored system row, as that row: same id and
     * shape as the history load, so a reload and a live event land on one row
     * and a Not delivered row turns sent in place.
     */
    private fun systemRow(event: ThreadRuntimeEvent.Extension): FeedItem.RawNotice? {
        val raw = event.raw
        fun str(key: String) = (raw.values[key] as? JsonString)?.value
        val messageId = str("messageId") ?: return null
        val content = when (event.type) {
            "approval.result", MERGE_BACK_ROW_EVENT -> str("content")
            "peer.undelivered" -> SystemMarkers.undeliveredMarker(
                PeerUndelivered(
                    to = str("peerThreadId") ?: return null,
                    toLabel = str("peerLabel") ?: return null,
                    reason = str("reason") ?: return null,
                    text = str("text") ?: return null,
                    sent = (raw.values["sent"] as? JsonBoolean)?.value == true,
                ),
            )
            else -> null
        } ?: return null
        return FeedItem.RawNotice("h-$messageId", SystemMarkers.ROW_EVENT_TYPE, content, raw)
    }

    private fun stopRetries(feed: List<FeedItem>): List<FeedItem> = feed.map {
        if (it is FeedItem.Retry) it.copy(active = false) else it
    }

    private fun upsert(feed: List<FeedItem>, item: FeedItem): List<FeedItem> {
        val identity = feedIdentity(item)
        val index = feed.indexOfFirst { feedIdentity(it) == identity }
        if (index < 0) return feed + item
        return feed.toMutableList().also { it[index] = item }
    }

    private fun historyShowsTaskNotification(feed: List<FeedItem>, event: ThreadEventPayload.TaskNotification): Boolean {
        val rows = feed.filterIsInstance<FeedItem.User>()
            .filter { it.fromTranscript && it.id.startsWith("h-") }
            .flatMap { user -> SyntheticUserMessage.split(user.text)?.parts.orEmpty().map { it to user.at } }
        return SyntheticUserMessage.transcriptShowsTaskNotification(rows, event.taskId, event.status, event.summary, event.at)
    }

    private fun feedIdentity(item: FeedItem): String =
        if (item is FeedItem.User && item.id.startsWith("h-remote_")) {
            item.id.removePrefix("h-")
        } else {
            item.id
        }

    private fun appendReplacing(feed: List<FeedItem>, item: FeedItem): List<FeedItem> =
        feed.filterNot { it.id == item.id } + item

    /**
     * Sequenced transports (WsHost) yield stable ids, so a replayed frame
     * upserts instead of duplicating. Unsequenced transports (TcpHost over IAP
     * stamps no seq) get a per-arrival id: byte-identical events, like repeated
     * plan-mode denials, must stay distinct rows.
     */
    private fun eventId(scoped: ScopedThreadEvent, prefix: String, arrival: Long): String =
        scoped.sequence?.let { "$prefix:seq:$it" }
            ?: "$prefix:${scoped.event.type}:${scoped.event.raw.hashCode()}:$arrival"
}

/** A fork's merge-back card in its parent (src/shared/merge-back.ts); `content` null once discarded. */
private const val MERGE_BACK_ROW_EVENT = "merge-back.row"
