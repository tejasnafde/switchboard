package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.local.CacheDao
import app.switchboard.mobile.data.local.CachedFeedRowEntity
import app.switchboard.mobile.data.local.CachedThreadEntity
import app.switchboard.mobile.data.local.CachedThreadWithFeed
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.util.concurrent.Executor

interface ThreadSnapshotStore {
    fun get(connectionId: String, threadId: String): ThreadState?

    fun save(connectionId: String, threadId: String, state: ThreadState)
}

data object NoOpThreadSnapshotStore : ThreadSnapshotStore {
    override fun get(connectionId: String, threadId: String): ThreadState? = null

    override fun save(connectionId: String, threadId: String, state: ThreadState) = Unit
}

class RoomThreadSnapshotStore(
    private val dao: CacheDao,
    private val writes: Executor,
) : ThreadSnapshotStore {
    private val states = linkedMapOf<String, ThreadState>()
    private val pending = linkedMapOf<String, PendingSnapshot>()
    private var drainScheduled = false

    @Synchronized
    override fun get(connectionId: String, threadId: String): ThreadState? =
        states[threadKey(connectionId, threadId)]

    override fun save(connectionId: String, threadId: String, state: ThreadState) {
        val stableState = state.copy(
            eventJournal = emptyList(),
            awaitingReseed = false,
            bufferedEvents = emptyList(),
        )
        val shouldSchedule = synchronized(this) {
            val key = threadKey(connectionId, threadId)
            states[key] = stableState
            pending[key] = PendingSnapshot(connectionId, threadId, stableState)
            if (drainScheduled) {
                false
            } else {
                drainScheduled = true
                true
            }
        }
        if (shouldSchedule) scheduleDrain()
    }

    @Synchronized
    fun seed(snapshot: OfflineSnapshot) {
        snapshot.cachedThreads.forEach { thread ->
            if (thread.threadKey in states) return@forEach
            val restored = CachedThreadStateMapper.from(
                thread,
                snapshot.feedRows.filter { it.threadKey == thread.threadKey },
            ) ?: return@forEach
            states[thread.threadKey] = restored
        }
    }

    private fun scheduleDrain() {
        try {
            writes.execute(::drain)
        } catch (_: RuntimeException) {
            synchronized(this) { drainScheduled = false }
        }
    }

    private fun drain() {
        while (true) {
            val next = synchronized(this) {
                val entry = pending.entries.firstOrNull()
                if (entry == null) {
                    drainScheduled = false
                    null
                } else {
                    pending.remove(entry.key)
                    entry.value
                }
            } ?: return
            runCatching {
                val encoded = ThreadSnapshotCacheCodec.encode(
                    next.connectionId,
                    next.threadId,
                    next.state,
                )
                dao.replaceThread(encoded.thread, encoded.feed)
            }
        }
    }

    private data class PendingSnapshot(
        val connectionId: String,
        val threadId: String,
        val state: ThreadState,
    )
}

object ThreadSnapshotCacheCodec {
    fun encode(
        connectionId: String,
        threadId: String,
        state: ThreadState,
    ): CachedThreadWithFeed {
        val key = threadKey(connectionId, threadId)
        val metadata = jsonObject(
            "status" to JsonString(state.status),
            "runtimeMode" to JsonString(state.runtimeMode),
            "provider" to state.provider.jsonString(),
            "instanceId" to state.instanceId.jsonString(),
            "instanceName" to state.instanceName.jsonString(),
            "sessionId" to state.sessionId.jsonString(),
            "usedTokens" to state.usedTokens.jsonNumber(),
            "maxTokens" to state.maxTokens.jsonNumber(),
            "costUsd" to state.costUsd.jsonNumber(),
            "resolvedModel" to state.resolvedModel.jsonString(),
            "availableVariants" to JsonArray(state.availableVariants.map(::JsonString)),
            "currentVariant" to state.currentVariant.jsonString(),
            "lastTurnDurationMs" to state.lastTurnDurationMs.jsonNumber(),
            "unread" to JsonNumber(state.unread.toString()),
            "driftWorktreePath" to state.drift?.worktreePath.jsonString(),
            "driftBranch" to state.drift?.branch.jsonString(),
            "spendInstanceId" to state.spendBlock?.instanceId.jsonString(),
            "spendModel" to state.spendBlock?.model.jsonString(),
            "spendReason" to state.spendBlock?.reason.jsonString(),
            "spendScope" to state.spendBlock?.scope.jsonString(),
            "spendResetsAtMs" to state.spendBlock?.resetsAtMs.jsonNumber(),
        )
        return CachedThreadWithFeed(
            thread = CachedThreadEntity(key, JsonCodec.encode(metadata)),
            feed = state.feed.mapIndexed { position, item ->
                CachedFeedRowEntity(
                    threadKey = key,
                    itemId = item.id,
                    position = position,
                    rawJson = JsonCodec.encode(encodeFeed(item)),
                )
            },
        )
    }

    private fun encodeFeed(item: FeedItem): JsonObject = when (item) {
        is FeedItem.User -> jsonObject(
            "kind" to JsonString("user"),
            "id" to JsonString(item.id),
            "text" to JsonString(item.text),
            "at" to JsonNumber(item.at.toString()),
            "images" to JsonArray(item.images.map { image ->
                jsonObject(
                    "url" to JsonString(image.url),
                    "mimeType" to image.mimeType.jsonString(),
                    "name" to image.name.jsonString(),
                )
            }),
            "pillsMeta" to JsonObject(linkedMapOf<String, JsonValue>().apply {
                item.pillsMeta.forEach { (id, pill) ->
                    this[id] = jsonObject(
                        "label" to JsonString(pill.label),
                        "kind" to JsonString(pill.kind),
                    )
                }
            }),
        )

        is FeedItem.Text -> jsonObject(
            "kind" to JsonString("text"),
            "id" to JsonString(item.id),
            "messageId" to JsonString(item.messageId),
            "text" to JsonString(item.text),
            "stream" to JsonString(item.stream),
            "done" to JsonBoolean(item.done),
            "durationMs" to item.durationMs.jsonNumber(),
        )

        is FeedItem.Tool -> jsonObject(
            "kind" to JsonString("tool"),
            "id" to JsonString(item.id),
            "toolId" to JsonString(item.toolId),
            "toolName" to JsonString(item.toolName),
            "input" to (item.input ?: JsonNull),
            "output" to item.output.jsonString(),
            "state" to JsonString(item.state),
        )

        is FeedItem.Denial -> jsonObject(
            "kind" to JsonString("denial"),
            "id" to JsonString(item.id),
            "toolName" to JsonString(item.toolName),
            "reason" to JsonString(item.reason),
            "mode" to JsonString(item.mode),
        )

        is FeedItem.Approval -> jsonObject(
            "kind" to JsonString("approval"),
            "id" to JsonString(item.id),
            "requestId" to JsonString(item.requestId),
            "toolName" to JsonString(item.toolName),
            "detail" to JsonString(item.detail),
            "requestType" to JsonString(item.requestType),
            "state" to JsonString(item.state),
        )

        is FeedItem.Retry -> jsonObject(
            "kind" to JsonString("retry"),
            "id" to JsonString(item.id),
            "turnId" to JsonString(item.turnId),
            "message" to JsonString(item.message),
            "active" to JsonBoolean(item.active),
        )

        is FeedItem.Error -> jsonObject(
            "kind" to JsonString("error"),
            "id" to JsonString(item.id),
            "message" to JsonString(item.message),
            "turnId" to item.turnId.jsonString(),
        )

        is FeedItem.Plan -> jsonObject(
            "kind" to JsonString("plan"),
            "id" to JsonString(item.id),
            "planId" to JsonString(item.planId),
            "markdown" to JsonString(item.markdown),
        )

        is FeedItem.Question -> jsonObject(
            "kind" to JsonString("question"),
            "id" to JsonString(item.id),
            "requestId" to JsonString(item.requestId),
            "questions" to JsonArray(item.questions.map { question ->
                jsonObject(
                    "id" to JsonString(question.id),
                    "header" to JsonString(question.header),
                    "question" to JsonString(question.question),
                    "options" to JsonArray(question.options.map { option ->
                        jsonObject(
                            "label" to JsonString(option.label),
                            "description" to option.description.jsonString(),
                        )
                    }),
                    "multiSelect" to JsonBoolean(question.multiSelect),
                )
            }),
            "answers" to item.answers?.let { answers ->
                JsonArray(answers.map { answer -> JsonArray(answer.map(::JsonString)) })
            },
        )

        is FeedItem.FileEdit -> jsonObject(
            "kind" to JsonString("fileEdit"),
            "id" to JsonString(item.id),
            "fileEditId" to JsonString(item.fileEditId),
            "repoRoot" to JsonString(item.repoRoot),
            "relPath" to JsonString(item.relPath),
            "changeKind" to JsonString(item.changeKind),
            "oldContent" to JsonString(item.oldContent),
            "newContent" to JsonString(item.newContent),
        )

        is FeedItem.Drift -> jsonObject(
            "kind" to JsonString("drift"),
            "id" to JsonString(item.id),
            "worktreePath" to JsonString(item.worktreePath),
            "branch" to JsonString(item.branch),
        )

        is FeedItem.SpendBlocked -> jsonObject(
            "kind" to JsonString("spendBlocked"),
            "id" to JsonString(item.id),
            "instanceId" to item.instanceId.jsonString(),
            "model" to item.model.jsonString(),
            "reason" to item.reason.jsonString(),
            "scope" to JsonString(item.scope),
            "resetsAtMs" to item.resetsAtMs.jsonNumber(),
        )

        is FeedItem.Peer -> jsonObject(
            "kind" to JsonString("peer"),
            "id" to JsonString(item.id),
            "direction" to JsonString(item.direction),
            "initiator" to JsonString(item.initiator),
            "messageId" to JsonString(item.messageId),
            "peerThreadId" to JsonString(item.peerThreadId),
            "peerLabel" to JsonString(item.peerLabel),
            "text" to JsonString(item.text),
            "at" to JsonNumber(item.at.toString()),
        )

        is FeedItem.Todo -> jsonObject(
            "kind" to JsonString("todo"),
            "id" to JsonString(item.id),
            "todoId" to JsonString(item.todoId),
            "items" to JsonArray(item.items.map { todo ->
                jsonObject(
                    "text" to JsonString(todo.text),
                    "status" to JsonString(todo.status),
                )
            }),
        )

        is FeedItem.RawNotice -> jsonObject(
            "kind" to JsonString("notice"),
            "id" to JsonString(item.id),
            "eventType" to JsonString(item.eventType),
            "text" to JsonString(item.text),
            "raw" to item.raw,
        )
    }

    private fun jsonObject(vararg fields: Pair<String, JsonValue?>): JsonObject =
        JsonObject(linkedMapOf<String, JsonValue>().apply {
            fields.forEach { (key, value) -> if (value != null) put(key, value) }
        })

    private fun String?.jsonString(): JsonString? = this?.let(::JsonString)

    private fun Long?.jsonNumber(): JsonNumber? = this?.let { JsonNumber(it.toString()) }

    private fun Double?.jsonNumber(): JsonNumber? = this?.let { JsonNumber(it.toString()) }
}

private fun threadKey(connectionId: String, threadId: String): String = "$connectionId:$threadId"
