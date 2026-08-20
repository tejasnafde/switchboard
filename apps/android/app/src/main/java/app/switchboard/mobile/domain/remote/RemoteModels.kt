package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.MessagePill
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonValue

enum class RuntimeMode(val wire: String) {
    Plan("plan"),
    Sandbox("sandbox"),
    AcceptEdits("accept-edits"),
    FullAccess("full-access"),
}

enum class ProviderKind(val wire: String) {
    Claude("claude"),
    Codex("codex"),
    OpenCode("opencode"),
}

enum class ApprovalDecision(val wire: String) {
    Approve("approve"),
    Deny("deny"),
}

data class SessionSummary(
    val id: String,
    val source: String,
    val title: String,
    val startedAt: Long,
    val messageCount: Long,
    val filePath: String,
    val raw: JsonObject,
    val agentType: String? = null,
    val worktreePath: String? = null,
    val worktreeBranch: String? = null,
)

data class MessageSearchResult(
    val messageId: String,
    val conversationId: String,
    val role: String,
    val content: String,
    val snippet: String,
    val conversationTitle: String,
    val projectPath: String,
    val agentType: String,
    val worktreePath: String?,
    val worktreeBranch: String?,
    val raw: JsonObject,
)

data class Project(
    val path: String,
    val name: String,
    val sessions: List<SessionSummary>,
    val workspaceId: String?,
    val raw: JsonObject,
)

data class Workspace(
    val id: String,
    val name: String,
    val color: String?,
    val sortOrder: Long,
    val createdAt: Long,
    val raw: JsonObject,
)

data class Conversation(
    val id: String,
    val projectPath: String,
    val agentType: String,
    val sessionId: String?,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
    val worktreePath: String?,
    val worktreeBranch: String?,
    val raw: JsonObject,
)

data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val timestamp: Long,
    val raw: JsonObject,
    val toolCalls: List<MessageToolCall> = emptyList(),
    val images: List<MessageImage> = emptyList(),
    val displayBody: String? = null,
    val pillsMeta: Map<String, MessagePill> = emptyMap(),
)

data class MessageToolCall(
    val id: String,
    val name: String,
    val input: String,
    val output: String?,
)

data class MessageImage(
    val url: String,
    val mimeType: String?,
    val name: String?,
)

data class SessionMeta(
    val id: String,
    val title: String,
    val projectPath: String,
    val agentType: String,
    val rootThreadId: String?,
    val raw: JsonObject,
)

data class LoadedSession(
    val messages: List<ChatMessage>,
    val meta: SessionMeta?,
    val total: Long?,
    val truncated: Boolean?,
    val raw: JsonObject,
)

data class ProviderSkill(
    val name: String,
    val description: String?,
    val argumentHint: String?,
    val path: String?,
    val source: String,
    val raw: JsonObject,
)

data class ModelOption(
    val id: String,
    val label: String,
    val tier: String,
    val raw: JsonObject,
)

data class ProviderInstance(
    val id: String,
    val agentType: String,
    val displayName: String,
    val accentColor: String?,
    val authMode: String,
    val envKeys: List<String>,
    val oauthDir: String?,
    val enabled: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val raw: JsonObject,
)

data class SessionDefaults(
    val runtimeMode: String?,
    val modelId: String?,
    val instanceId: String?,
)

data class StartedSession(
    val threadId: String,
    val provider: String,
    val status: String,
    val cwd: String,
    val sessionId: String?,
    val raw: JsonObject,
)

data class MarkReadResult(
    val ok: Boolean,
    val at: Long,
    val raw: JsonObject,
)

sealed interface CurrentBranchResult {
    data class Available(val branch: String?) : CurrentBranchResult

    data class Unavailable(
        val message: String,
        val missing: Boolean,
    ) : CurrentBranchResult
}

data class CreateConversation(
    val id: String,
    val projectPath: String,
    val agentType: String,
    val title: String? = null,
    val worktreePath: String? = null,
    val worktreeBranch: String? = null,
)

data class StartSession(
    val threadId: String,
    val provider: ProviderKind,
    val cwd: String,
    val model: String? = null,
    val runtimeMode: RuntimeMode? = null,
    val resumeSessionId: String? = null,
    val instanceId: String? = null,
)

data class ImageInput(
    val url: String,
    val mimeType: String? = null,
)

data class AnswerQuestion(
    val threadId: String,
    val requestId: String,
    val answers: List<List<String>>,
)

data class RemoteRequestKey(
    val connectionId: String,
    val generation: Long,
    val operation: String,
)

sealed interface RemoteOutcome<out T> {
    data class Success<T>(val value: T) : RemoteOutcome<T>

    data class Failure(val message: String) : RemoteOutcome<Nothing>
}

data class RemoteResponse<T>(
    val key: RemoteRequestKey,
    val outcome: RemoteOutcome<T>,
)

data class CommandFollowUp<C, F>(
    val command: RemoteResponse<C>,
    val followUp: RemoteResponse<F>?,
)

data class CommandBody(
    val body: JsonValue?,
)

sealed interface ArchiveConversationResult {
    data object Archived : ArchiveConversationResult
}
