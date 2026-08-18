package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonValue

enum class ThreadEventKind {
    Content,
    UserMessage,
    ToolStarted,
    ToolCompleted,
    ToolDenied,
    RequestOpened,
    RequestClosed,
    TurnCompleted,
    TurnRetrying,
    Error,
    Status,
    Session,
    SessionProvider,
    ContextWindow,
    ModelVariants,
    PlanProposed,
    QuestionAsked,
    QuestionAnswered,
    FileEdited,
    WorktreeDrift,
    SpendBlocked,
    ThreadRead,
    PeerMessage,
    TodoUpdated,
    Extension,
    Malformed,
}

data class ThreadEventScope(
    val connectionId: String,
    val generation: Long,
)

data class QuestionOption(
    val label: String,
    val description: String?,
)

data class ThreadQuestion(
    val id: String,
    val header: String,
    val question: String,
    val options: List<QuestionOption>,
    val multiSelect: Boolean,
)

data class TodoEntry(
    val text: String,
    val status: String,
)

sealed interface ThreadEventPayload {
    data class Content(val messageId: String, val text: String, val append: Boolean, val streamKind: String) : ThreadEventPayload
    data class UserMessage(val text: String, val origin: String?, val at: Long) : ThreadEventPayload
    data class ToolStarted(val toolId: String, val toolName: String, val input: JsonValue) : ThreadEventPayload
    data class ToolCompleted(val toolId: String, val output: String?) : ThreadEventPayload
    data class ToolDenied(val toolName: String, val reason: String, val mode: String) : ThreadEventPayload
    data class RequestOpened(val requestId: String, val requestType: String, val toolName: String, val detail: String) : ThreadEventPayload
    data class RequestClosed(val requestId: String, val decision: String) : ThreadEventPayload
    data class TurnCompleted(
        val turnId: String?,
        val costUsd: Double?,
        val usedTokens: Long?,
        val maxTokens: Long?,
        val numTurns: Long?,
        val durationMs: Long?,
    ) : ThreadEventPayload
    data class TurnRetrying(val turnId: String, val message: String) : ThreadEventPayload
    data class Error(val message: String, val turnId: String?) : ThreadEventPayload
    data class Status(val status: String) : ThreadEventPayload
    data class Session(val sessionId: String) : ThreadEventPayload
    data class SessionProvider(val provider: String, val instanceId: String?, val instanceName: String?) : ThreadEventPayload
    data class ContextWindow(
        val usedTokens: Long,
        val maxTokens: Long?,
        val model: String?,
        val costUsd: Double?,
    ) : ThreadEventPayload
    data class ModelVariants(val modelId: String, val availableVariants: List<String>, val currentVariant: String) : ThreadEventPayload
    data class PlanProposed(val planId: String, val markdown: String) : ThreadEventPayload
    data class QuestionAsked(val requestId: String, val questions: List<ThreadQuestion>) : ThreadEventPayload
    data class QuestionAnswered(val requestId: String, val answers: List<List<String>>) : ThreadEventPayload
    data class FileEdited(
        val turnId: String,
        val fileEditId: String,
        val repoRoot: String,
        val relPath: String,
        val changeKind: String,
        val oldContent: String,
        val newContent: String,
    ) : ThreadEventPayload
    data class WorktreeDrift(val worktreePath: String, val branch: String) : ThreadEventPayload
    data class SpendBlocked(
        val instanceId: String?,
        val model: String?,
        val reason: String?,
        val scope: String,
        val resetsAtMs: Long?,
    ) : ThreadEventPayload
    data class ThreadRead(val at: Long) : ThreadEventPayload
    data class PeerMessage(
        val direction: String,
        val initiator: String,
        val messageId: String,
        val peerThreadId: String,
        val peerLabel: String,
        val text: String,
        val at: Long,
    ) : ThreadEventPayload
    data class TodoUpdated(val todoId: String, val items: List<TodoEntry>) : ThreadEventPayload
}

sealed interface ThreadRuntimeEvent {
    val kind: ThreadEventKind
    val type: String
    val threadId: String
    val raw: JsonObject

    data class Known(
        override val kind: ThreadEventKind,
        override val type: String,
        override val threadId: String,
        val payload: ThreadEventPayload,
        override val raw: JsonObject,
    ) : ThreadRuntimeEvent

    data class Extension(
        override val type: String,
        override val threadId: String,
        override val raw: JsonObject,
    ) : ThreadRuntimeEvent {
        override val kind = ThreadEventKind.Extension
    }

    data class Malformed(
        override val type: String,
        override val threadId: String,
        val error: String,
        override val raw: JsonObject,
    ) : ThreadRuntimeEvent {
        override val kind = ThreadEventKind.Malformed
    }
}

sealed interface FeedItem {
    val id: String

    data class User(
        override val id: String,
        val text: String,
        val at: Long,
        val images: List<MessageImage> = emptyList(),
    ) : FeedItem
    data class Text(
        override val id: String,
        val messageId: String,
        val text: String,
        val stream: String,
        val done: Boolean = false,
        val durationMs: Long? = null,
    ) : FeedItem
    data class Tool(
        override val id: String,
        val toolId: String,
        val toolName: String,
        val input: JsonValue?,
        val output: String? = null,
        val state: String,
    ) : FeedItem
    data class Denial(override val id: String, val toolName: String, val reason: String, val mode: String) : FeedItem
    data class Approval(
        override val id: String,
        val requestId: String,
        val toolName: String,
        val detail: String,
        val requestType: String,
        val state: String,
    ) : FeedItem
    data class Retry(override val id: String, val turnId: String, val message: String, val active: Boolean) : FeedItem
    data class Error(override val id: String, val message: String, val turnId: String?) : FeedItem
    data class Plan(override val id: String, val planId: String, val markdown: String) : FeedItem
    data class Question(
        override val id: String,
        val requestId: String,
        val questions: List<ThreadQuestion>,
        val answers: List<List<String>>? = null,
    ) : FeedItem
    data class FileEdit(
        override val id: String,
        val fileEditId: String,
        val repoRoot: String,
        val relPath: String,
        val changeKind: String,
        val oldContent: String,
        val newContent: String,
    ) : FeedItem
    data class Drift(override val id: String, val worktreePath: String, val branch: String) : FeedItem
    data class SpendBlocked(
        override val id: String,
        val instanceId: String?,
        val model: String?,
        val reason: String?,
        val scope: String,
        val resetsAtMs: Long?,
    ) : FeedItem
    data class Peer(
        override val id: String,
        val direction: String,
        val initiator: String,
        val messageId: String,
        val peerThreadId: String,
        val peerLabel: String,
        val text: String,
        val at: Long,
    ) : FeedItem
    data class Todo(override val id: String, val todoId: String, val items: List<TodoEntry>) : FeedItem
    data class RawNotice(
        override val id: String,
        val eventType: String,
        val text: String,
        val raw: JsonObject,
    ) : FeedItem
}

data class ThreadSnapshot(
    val threadId: String,
    val feed: List<FeedItem>,
)

data class DriftSuggestion(val worktreePath: String, val branch: String)

data class SpendBlock(
    val instanceId: String?,
    val model: String?,
    val reason: String?,
    val scope: String,
    val resetsAtMs: Long?,
)
