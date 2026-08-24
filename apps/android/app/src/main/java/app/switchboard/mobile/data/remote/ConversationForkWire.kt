package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.ForkConversationOutcome
import app.switchboard.mobile.domain.remote.ForkConversationRequest
import app.switchboard.mobile.domain.remote.ForkConversationResult
import app.switchboard.mobile.domain.remote.ForkConversationState
import app.switchboard.mobile.domain.remote.ForkDirtySource
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.security.MessageDigest

object ConversationForkWire {
    fun request(
        requestId: String,
        sourceConversationId: String,
        message: ChatMessage,
        withWorktree: Boolean,
        requestedAt: Long,
        confirmation: ForkDirtySource? = null,
    ): ForkConversationRequest {
        val kind = if (withWorktree) "new-worktree" else "shared-checkout"
        val checkout = linkedMapOf<String, JsonValue>("kind" to JsonString(kind))
        if (withWorktree) {
            checkout["basePolicy"] = JsonString("source-head")
            if (confirmation != null) checkout["dirtySourceConfirmed"] = JsonObject(linkedMapOf(
                "headSha" to JsonString(confirmation.headSha),
                "statusDigest" to JsonString(confirmation.statusDigest),
            ))
        }
        val raw = JsonObject(linkedMapOf(
            "schemaVersion" to JsonNumber("1"),
            "requestId" to JsonString(requestId),
            "sourceConversationId" to JsonString(sourceConversationId),
            "anchor" to JsonObject(linkedMapOf(
                "messageId" to JsonString(message.id),
                "role" to JsonString(message.role),
                "timestamp" to JsonNumber(message.timestamp.toString()),
                "contentDigest" to JsonString(digest(canonicalMessage(message.raw))),
            )),
            "checkout" to JsonObject(checkout),
            "provenance" to JsonObject(linkedMapOf(
                "surface" to JsonString("android"),
                "requestedAt" to JsonNumber(requestedAt.toString()),
            )),
        ))
        return ForkConversationRequest(requestId, sourceConversationId, raw)
    }

    fun outcome(value: JsonValue?): ForkConversationOutcome {
        val root = value.objectRequired("fork outcome")
        return when (root.string("kind")) {
            "confirmation-required" -> ForkConversationOutcome.ConfirmationRequired(
                requestId = root.stringRequired("requestId"),
                dirtySource = root.required("dirtySource").objectRequired("dirtySource").let { dirty ->
                    ForkDirtySource(
                        headSha = dirty.stringRequired("headSha"),
                        statusDigest = dirty.stringRequired("statusDigest"),
                        trackedChanges = dirty.longRequired("trackedChanges"),
                        untrackedChanges = dirty.longRequired("untrackedChanges"),
                        omittedChangeSummary = dirty.stringRequired("omittedChangeSummary"),
                    )
                },
            )
            "completed" -> {
                val result = root.required("result").objectRequired("result")
                val conversation = result.required("conversation").objectRequired("conversation")
                val anchor = conversation.required("anchor").objectRequired("anchor")
                ForkConversationOutcome.Completed(ForkConversationResult(
                    requestId = result.stringRequired("requestId"),
                    conversation = ForkConversationState(
                        id = conversation.stringRequired("id"),
                        projectPath = conversation.stringRequired("projectPath"),
                        worktreePath = conversation.string("worktreePath"),
                        worktreeBranch = conversation.string("worktreeBranch"),
                        worktreeId = conversation.string("worktreeId"),
                        agentType = conversation.stringRequired("agentType"),
                        providerInstanceId = conversation.string("providerInstanceId"),
                        runtimeMode = conversation.stringRequired("runtimeMode"),
                        model = conversation.string("model"),
                        reasoningEffort = conversation.string("reasoningEffort"),
                        title = conversation.stringRequired("title"),
                        parentConversationId = conversation.stringRequired("parentConversationId"),
                        parentTitle = conversation.stringRequired("parentTitle"),
                        resumeMode = conversation.stringRequired("resumeMode"),
                        anchorMessageId = anchor.stringRequired("messageId"),
                        anchorPreview = anchor.stringRequired("preview"),
                    ),
                ))
            }
            "failed" -> {
                val error = root.required("error").objectRequired("error")
                val recovery = root.values["recovery"] as? JsonObject
                ForkConversationOutcome.Failed(
                    requestId = root.stringRequired("requestId"),
                    code = error.stringRequired("code"),
                    message = error.stringRequired("message"),
                    retryable = error.booleanRequired("retryable"),
                    retainedPath = recovery?.string("retainedPath"),
                    retainedBranch = recovery?.string("retainedBranch"),
                )
            }
            else -> error("Unsupported fork outcome")
        }
    }

    private fun canonicalMessage(raw: JsonObject): String =
        JsonCodec.encode(sort(JsonObject(linkedMapOf<String, JsonValue>().apply {
            raw.values.filterKeys { it != "id" }.forEach(::put)
        })))

    private fun sort(value: JsonValue): JsonValue = when (value) {
        is JsonObject -> JsonObject(linkedMapOf<String, JsonValue>().apply {
            value.values.keys.sorted().forEach { key -> put(key, sort(value.values.getValue(key))) }
        })
        is JsonArray -> JsonArray(value.values.map(::sort))
        else -> value
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }

    private fun JsonValue?.objectRequired(label: String): JsonObject =
        this as? JsonObject ?: error("Expected $label object")
    private fun JsonObject.required(key: String): JsonValue = values[key] ?: error("Missing $key")
    private fun JsonObject.stringRequired(key: String): String =
        (required(key) as? JsonString)?.value ?: error("Expected $key string")
    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value
    private fun JsonObject.longRequired(key: String): Long =
        (required(key) as? JsonNumber)?.source?.toLongOrNull() ?: error("Expected $key number")
    private fun JsonObject.booleanRequired(key: String): Boolean =
        (required(key) as? JsonBoolean)?.value ?: error("Expected $key boolean")
}
