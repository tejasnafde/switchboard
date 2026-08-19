package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

object ThreadEventDecoder {
    fun decode(raw: JsonObject): ThreadRuntimeEvent {
        val type = raw.string("type") ?: "unknown"
        val threadId = raw.string("threadId") ?: "unknown"
        val decoded = try {
            payload(type, raw)
        } catch (error: RuntimeException) {
            return ThreadRuntimeEvent.Malformed(
                type,
                threadId,
                error.message ?: "Invalid event payload",
                raw,
            )
        }
        return if (decoded == null) {
            ThreadRuntimeEvent.Extension(type, threadId, raw)
        } else {
            ThreadRuntimeEvent.Known(decoded.first, type, threadId, decoded.second, raw)
        }
    }

    private fun payload(type: String, raw: JsonObject): Pair<ThreadEventKind, ThreadEventPayload>? =
        when (type) {
            "content" -> ThreadEventKind.Content to ThreadEventPayload.Content(
                raw.requiredString("messageId"), raw.requiredString("text"),
                raw.boolean("append") ?: false, raw.requiredString("streamKind"),
            )
            "user.message" -> ThreadEventKind.UserMessage to ThreadEventPayload.UserMessage(
                raw.requiredString("text"), raw.string("displayBody"),
                raw.optionalArray("images").values.map { image ->
                    val value = image as? JsonObject ?: error("Expected image object")
                    MessageImage(
                        value.requiredString("url"),
                        value.string("mimeType"),
                        value.string("name"),
                    )
                },
                raw.string("origin"), raw.requiredLong("at"),
                decodeMessagePills(raw.values["pillsMeta"]),
            )
            "tool.started" -> ThreadEventKind.ToolStarted to ThreadEventPayload.ToolStarted(
                raw.requiredString("toolId"), raw.requiredString("toolName"), raw.required("input"),
            )
            "tool.completed" -> ThreadEventKind.ToolCompleted to ThreadEventPayload.ToolCompleted(
                raw.requiredString("toolId"), raw.string("output"),
            )
            "tool.denied" -> ThreadEventKind.ToolDenied to ThreadEventPayload.ToolDenied(
                raw.requiredString("toolName"), raw.requiredString("reason"), raw.requiredString("mode"),
            )
            "request.opened" -> ThreadEventKind.RequestOpened to ThreadEventPayload.RequestOpened(
                raw.requiredString("requestId"), raw.requiredString("requestType"),
                raw.requiredString("toolName"), raw.requiredString("detail"),
            )
            "request.closed" -> ThreadEventKind.RequestClosed to ThreadEventPayload.RequestClosed(
                raw.requiredString("requestId"), raw.requiredString("decision"),
            )
            "turn.completed" -> ThreadEventKind.TurnCompleted to ThreadEventPayload.TurnCompleted(
                raw.string("turnId"), raw.double("costUsd"), raw.long("usedTokens"),
                raw.long("maxTokens"), raw.long("numTurns"), raw.long("durationMs"),
            )
            "turn.retrying" -> ThreadEventKind.TurnRetrying to ThreadEventPayload.TurnRetrying(
                raw.requiredString("turnId"), raw.requiredString("message"),
            )
            "error" -> ThreadEventKind.Error to ThreadEventPayload.Error(
                raw.requiredString("message"), raw.string("turnId"),
            )
            "status" -> ThreadEventKind.Status to ThreadEventPayload.Status(raw.requiredString("status"))
            "session" -> ThreadEventKind.Session to ThreadEventPayload.Session(raw.requiredString("sessionId"))
            "session.provider" -> ThreadEventKind.SessionProvider to ThreadEventPayload.SessionProvider(
                raw.requiredString("provider"), raw.string("instanceId"), raw.string("instanceName"),
            )
            "context_window" -> ThreadEventKind.ContextWindow to ThreadEventPayload.ContextWindow(
                raw.requiredLong("usedTokens"), raw.long("maxTokens"), raw.string("model"), raw.double("costUsd"),
            )
            "model.variants" -> ThreadEventKind.ModelVariants to ThreadEventPayload.ModelVariants(
                raw.requiredString("modelId"), raw.requiredStringList("availableVariants"),
                raw.requiredString("currentVariant"),
            )
            "plan.proposed" -> ThreadEventKind.PlanProposed to ThreadEventPayload.PlanProposed(
                raw.requiredString("planId"), raw.requiredString("planMarkdown"),
            )
            "question.asked" -> ThreadEventKind.QuestionAsked to ThreadEventPayload.QuestionAsked(
                raw.requiredString("requestId"), raw.requiredArray("questions").values.map(::question),
            )
            "question.answered" -> ThreadEventKind.QuestionAnswered to ThreadEventPayload.QuestionAnswered(
                raw.requiredString("requestId"),
                raw.requiredArray("answers").values.map { answer ->
                    (answer as? JsonArray)?.values?.map {
                        (it as? JsonString)?.value ?: error("Expected answer string")
                    } ?: error("Expected answer row")
                },
            )
            "file.edited" -> ThreadEventKind.FileEdited to ThreadEventPayload.FileEdited(
                raw.requiredString("turnId"), raw.requiredString("fileEditId"),
                raw.requiredString("repoRoot"), raw.requiredString("relPath"),
                raw.requiredString("changeKind"), raw.requiredString("oldContent"),
                raw.requiredString("newContent"),
            )
            "worktree.drift" -> ThreadEventKind.WorktreeDrift to ThreadEventPayload.WorktreeDrift(
                raw.requiredString("worktreePath"), raw.requiredString("branch"),
            )
            "spend.blocked" -> ThreadEventKind.SpendBlocked to ThreadEventPayload.SpendBlocked(
                raw.string("instanceId"), raw.string("model"), raw.string("reason"),
                raw.requiredString("scope"), raw.long("resetsAtMs"),
            )
            "thread.read" -> ThreadEventKind.ThreadRead to ThreadEventPayload.ThreadRead(raw.requiredLong("at"))
            "peer.message" -> ThreadEventKind.PeerMessage to ThreadEventPayload.PeerMessage(
                raw.requiredString("direction"), raw.requiredString("initiator"),
                raw.requiredString("messageId"), raw.requiredString("peerThreadId"),
                raw.requiredString("peerLabel"), raw.requiredString("text"), raw.requiredLong("at"),
            )
            "todo.updated" -> ThreadEventKind.TodoUpdated to ThreadEventPayload.TodoUpdated(
                raw.requiredString("todoId"), raw.requiredArray("items").values.map { item ->
                    val value = item as? JsonObject ?: error("Expected todo object")
                    TodoEntry(value.requiredString("text"), value.requiredString("status"))
                },
            )
            else -> null
        }

    private fun question(value: JsonValue): ThreadQuestion {
        val raw = value as? JsonObject ?: error("Expected question object")
        return ThreadQuestion(
            raw.requiredString("id"),
            raw.requiredString("header"),
            raw.requiredString("question"),
            raw.requiredArray("options").values.map { option ->
                val item = option as? JsonObject ?: error("Expected option object")
                QuestionOption(item.requiredString("label"), item.string("description"))
            },
            raw.requiredBoolean("multiSelect"),
        )
    }

    private fun JsonObject.required(key: String): JsonValue = values[key] ?: error("Missing field: $key")
    private fun JsonObject.requiredString(key: String) = (required(key) as? JsonString)?.value ?: error("Expected string: $key")
    private fun JsonObject.string(key: String): String? = when (val value = values[key]) {
        null, JsonNull -> null
        is JsonString -> value.value
        else -> error("Expected nullable string: $key")
    }
    private fun JsonObject.requiredLong(key: String) = (required(key) as? JsonNumber)?.source?.toLongOrNull() ?: error("Expected integer: $key")
    private fun JsonObject.long(key: String): Long? = when (val value = values[key]) {
        null, JsonNull -> null
        is JsonNumber -> value.source.toLongOrNull() ?: error("Expected integer: $key")
        else -> error("Expected nullable integer: $key")
    }
    private fun JsonObject.double(key: String): Double? = when (val value = values[key]) {
        null, JsonNull -> null
        is JsonNumber -> value.source.toDoubleOrNull() ?: error("Expected number: $key")
        else -> error("Expected nullable number: $key")
    }
    private fun JsonObject.boolean(key: String): Boolean? = when (val value = values[key]) {
        null, JsonNull -> null
        is JsonBoolean -> value.value
        else -> error("Expected nullable boolean: $key")
    }
    private fun JsonObject.requiredBoolean(key: String) = (required(key) as? JsonBoolean)?.value ?: error("Expected boolean: $key")
    private fun JsonObject.requiredArray(key: String) = required(key) as? JsonArray ?: error("Expected array: $key")
    private fun JsonObject.optionalArray(key: String) = when (val value = values[key]) {
        null, JsonNull -> JsonArray(emptyList())
        is JsonArray -> value
        else -> error("Expected nullable array: $key")
    }
    private fun JsonObject.requiredStringList(key: String) = requiredArray(key).values.map {
        (it as? JsonString)?.value ?: error("Expected string in: $key")
    }
}
