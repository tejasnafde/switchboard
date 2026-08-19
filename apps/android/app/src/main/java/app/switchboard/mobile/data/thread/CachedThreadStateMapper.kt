package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.local.CachedFeedRowEntity
import app.switchboard.mobile.data.local.CachedThreadEntity
import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.domain.thread.DriftSuggestion
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.QuestionOption
import app.switchboard.mobile.domain.thread.SpendBlock
import app.switchboard.mobile.domain.thread.TodoEntry
import app.switchboard.mobile.domain.thread.ThreadQuestion
import app.switchboard.mobile.domain.thread.decodeMessagePills
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

object CachedThreadStateMapper {
    fun from(
        snapshot: OfflineSnapshot,
        connectionId: String,
        threadId: String,
    ): ThreadState? {
        val threadKey = "$connectionId:$threadId"
        val thread = snapshot.cachedThreads.firstOrNull { it.threadKey == threadKey } ?: return null
        return from(
            thread,
            snapshot.feedRows.filter { it.threadKey == threadKey },
        )
    }

    fun from(
        thread: CachedThreadEntity,
        rows: List<CachedFeedRowEntity>,
    ): ThreadState? {
        val metadata = runCatching { JsonCodec.parse(thread.rawJson) as? JsonObject }.getOrNull()
            ?: JsonObject(linkedMapOf())
        val feed = rows
            .asSequence()
            .filter { it.threadKey == thread.threadKey }
            .sortedWith(compareBy({ it.position }, { it.itemId }))
            .mapNotNull { row -> decodeFeedItem(row.rawJson) }
            .toList()
        return ThreadState(
            feed = feed,
            status = metadata.string("status") ?: "connecting",
            runtimeMode = metadata.string("runtimeMode") ?: "sandbox",
            provider = metadata.string("provider"),
            instanceId = metadata.string("instanceId"),
            instanceName = metadata.string("instanceName"),
            sessionId = metadata.string("sessionId"),
            usedTokens = metadata.long("usedTokens"),
            maxTokens = metadata.long("maxTokens"),
            costUsd = metadata.double("costUsd"),
            resolvedModel = metadata.string("resolvedModel"),
            availableVariants = metadata.stringArray("availableVariants"),
            currentVariant = metadata.string("currentVariant"),
            lastTurnDurationMs = metadata.long("lastTurnDurationMs"),
            unread = metadata.long("unread")?.toInt()?.coerceAtLeast(0) ?: 0,
            drift = metadata.drift(),
            spendBlock = metadata.spendBlock(),
        )
    }

    private fun decodeFeedItem(source: String): FeedItem? {
        val value = runCatching { JsonCodec.parse(source) as? JsonObject }.getOrNull() ?: return null
        val id = value.string("id") ?: return null
        val text = value.string("text").orEmpty()
        return when (value.string("kind")) {
            "user" -> FeedItem.User(
                id = id,
                text = text,
                at = value.long("at") ?: 0,
                images = (value.values["images"] as? JsonArray)
                    ?.values
                    .orEmpty()
                    .mapNotNull(::decodeImage),
                pillsMeta = decodeMessagePills(value.values["pillsMeta"]),
            )

            "text" -> FeedItem.Text(
                id = id,
                messageId = id,
                text = text,
                stream = value.string("stream") ?: "assistant",
                done = (value.values["done"] as? JsonBoolean)?.value ?: true,
                durationMs = value.long("durationMs"),
            )

            "tool" -> FeedItem.Tool(
                id = id,
                toolId = value.string("toolId") ?: id.removePrefix("t-"),
                toolName = value.string("toolName") ?: "Tool",
                input = value.values["input"].takeUnless { it == JsonNull },
                output = value.string("output"),
                state = value.string("state") ?: "done",
            )

            "denial" -> FeedItem.Denial(
                id = id,
                toolName = value.string("toolName") ?: "Tool",
                reason = value.string("reason").orEmpty(),
                mode = value.string("mode").orEmpty(),
            )

            "approval" -> FeedItem.Approval(
                id = id,
                requestId = value.string("requestId") ?: id.removePrefix("a-"),
                toolName = value.string("toolName") ?: "Tool",
                detail = value.string("detail").orEmpty(),
                requestType = value.string("requestType") ?: "tool",
                state = value.string("state") ?: "pending",
            )

            "question" -> FeedItem.Question(
                id = id,
                requestId = value.string("requestId") ?: id.removePrefix("q-"),
                questions = value.questions(),
                answers = value.answers(),
            )

            "plan" -> FeedItem.Plan(
                id = id,
                planId = value.string("planId") ?: id.removePrefix("p-"),
                markdown = value.string("markdown").orEmpty(),
            )

            "fileEdit" -> FeedItem.FileEdit(
                id = id,
                fileEditId = value.string("fileEditId") ?: id.removePrefix("f-"),
                repoRoot = value.string("repoRoot").orEmpty(),
                relPath = value.string("relPath").orEmpty(),
                changeKind = value.string("changeKind") ?: "modify",
                oldContent = value.string("oldContent").orEmpty(),
                newContent = value.string("newContent").orEmpty(),
            )

            "retry" -> FeedItem.Retry(
                id = id,
                turnId = value.string("turnId").orEmpty(),
                message = value.string("message").orEmpty(),
                active = value.boolean("active") ?: false,
            )

            "drift" -> FeedItem.Drift(
                id = id,
                worktreePath = value.string("worktreePath").orEmpty(),
                branch = value.string("branch").orEmpty(),
            )

            "spendBlocked" -> FeedItem.SpendBlocked(
                id = id,
                instanceId = value.string("instanceId"),
                model = value.string("model"),
                reason = value.string("reason"),
                scope = value.string("scope").orEmpty(),
                resetsAtMs = value.long("resetsAtMs"),
            )

            "peer" -> FeedItem.Peer(
                id = id,
                direction = value.string("direction").orEmpty(),
                initiator = value.string("initiator").orEmpty(),
                messageId = value.string("messageId").orEmpty(),
                peerThreadId = value.string("peerThreadId").orEmpty(),
                peerLabel = value.string("peerLabel").orEmpty(),
                text = text,
                at = value.long("at") ?: 0,
            )

            "todo" -> FeedItem.Todo(
                id = id,
                todoId = value.string("todoId").orEmpty(),
                items = value.todoItems(),
            )

            "error" -> FeedItem.Error(id, value.string("message") ?: text, value.string("turnId"))
            "notice" -> FeedItem.RawNotice(
                id,
                value.string("eventType") ?: "cache.notice",
                text,
                value.values["raw"] as? JsonObject ?: value,
            )
            else -> null
        }
    }

    private fun decodeImage(value: app.switchboard.mobile.protocol.JsonValue): MessageImage? = when (value) {
        is JsonString -> MessageImage(value.value, null, null)
        is JsonObject -> value.string("url")?.let { url ->
            MessageImage(url, value.string("mimeType"), value.string("name"))
        }
        else -> null
    }

    private fun JsonObject.string(key: String): String? =
        (values[key] as? JsonString)?.value

    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.toLongOrNull()

    private fun JsonObject.double(key: String): Double? =
        (values[key] as? JsonNumber)?.source?.toDoubleOrNull()

    private fun JsonObject.boolean(key: String): Boolean? =
        (values[key] as? JsonBoolean)?.value

    private fun JsonObject.stringArray(key: String): List<String> =
        (values[key] as? JsonArray)?.values.orEmpty().mapNotNull { (it as? JsonString)?.value }

    private fun JsonObject.drift(): DriftSuggestion? {
        val path = string("driftWorktreePath") ?: return null
        return DriftSuggestion(path, string("driftBranch").orEmpty())
    }

    private fun JsonObject.spendBlock(): SpendBlock? {
        val scope = string("spendScope") ?: return null
        return SpendBlock(
            instanceId = string("spendInstanceId"),
            model = string("spendModel"),
            reason = string("spendReason"),
            scope = scope,
            resetsAtMs = long("spendResetsAtMs"),
        )
    }

    private fun JsonObject.todoItems(): List<TodoEntry> =
        (values["items"] as? JsonArray)?.values.orEmpty().mapNotNull { encoded ->
            val item = encoded as? JsonObject ?: return@mapNotNull null
            val itemText = item.string("text") ?: return@mapNotNull null
            TodoEntry(itemText, item.string("status").orEmpty())
        }

    private fun JsonObject.questions(): List<ThreadQuestion> =
        (values["questions"] as? JsonArray)?.values.orEmpty().mapNotNull { encoded ->
            val question = encoded as? JsonObject ?: return@mapNotNull null
            val questionId = question.string("id") ?: return@mapNotNull null
            ThreadQuestion(
                id = questionId,
                header = question.string("header").orEmpty(),
                question = question.string("question").orEmpty(),
                options = (question.values["options"] as? JsonArray)?.values.orEmpty().mapNotNull { encodedOption ->
                    val option = encodedOption as? JsonObject ?: return@mapNotNull null
                    val label = option.string("label") ?: return@mapNotNull null
                    QuestionOption(label, option.string("description"))
                },
                multiSelect = (question.values["multiSelect"] as? JsonBoolean)?.value ?: false,
            )
        }

    private fun JsonObject.answers(): List<List<String>>? =
        (values["answers"] as? JsonArray)?.values?.map { encodedAnswer ->
            (encodedAnswer as? JsonArray)?.values.orEmpty().mapNotNull { (it as? JsonString)?.value }
        }
}
