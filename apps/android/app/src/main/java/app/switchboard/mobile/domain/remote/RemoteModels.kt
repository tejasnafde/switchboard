package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.MessagePill
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonValue

enum class RuntimeMode(val wire: String) {
    Plan("plan"),
    Sandbox("sandbox"),
    AcceptEdits("accept-edits"),
    Auto("auto"),
    FullAccess("full-access"),
}

enum class ProviderKind(val wire: String) {
    Claude("claude"),
    Codex("codex"),
    OpenCode("opencode"),
    Gemini("gemini"),
    Vibe("vibe"),
    Cline("cline"),
    Copilot("copilot"),
}

/**
 * Agents the backend drives over the Agent Client Protocol, as in
 * src/shared/acp-agents.ts. One prompt per session at a time, so they never
 * steer. The generic ones are staged on Android (flag native_generic_acp_agents):
 * their chats show and continue, but a new chat cannot pick them.
 */
object AcpAgents {
    private val generic = linkedMapOf(
        "gemini" to Pair("Gemini CLI", "Gemini"),
        "vibe" to Pair("Mistral Vibe", "Vibe"),
        "cline" to Pair("Cline", "Cline"),
        "copilot" to Pair("GitHub Copilot", "Copilot"),
    )

    fun speaksAcp(provider: String?): Boolean = provider == "opencode" || provider in generic

    fun isGeneric(provider: String?): Boolean = provider in generic

    fun label(provider: String?): String? = generic[provider]?.first

    fun shortLabel(provider: String?): String? = generic[provider]?.second
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
    val originSource: String? = null,
    /** Last finished turn's preview line, stored by the backend. */
    val statusLine: String? = null,
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
    val fileDiff: MessageFileDiff? = null,
)

/** A turn's changed-file card, mirrored by the backend so history keeps it. */
data class MessageFileDiff(
    val fileEditId: String,
    val repoRoot: String,
    val relPath: String,
    val changeKind: String,
    val oldContent: String,
    val newContent: String,
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
    val worktreePath: String? = null,
    val worktreeBranch: String? = null,
    val worktreeId: String? = null,
    val providerInstanceId: String? = null,
    val runtimeMode: String? = null,
    val model: String? = null,
    val reasoningEffort: String? = null,
    val forkMetadata: ForkLineageMetadata? = null,
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
    /** Canonical id an alias row resolves to, when the provider says so
     *  (Claude only). Mirrors ModelOption.resolvedModel in src/shared/models.ts. */
    val resolvedModel: String? = null,
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

data class CommandBody(
    val body: JsonValue?,
) {
    /**
     * A Stop answered `{ live: false }`: the backend had no turn, so a thread
     * still shown as running is stale. An older backend answers nothing.
     */
    val foundNoTurn: Boolean
        get() = ((body as? JsonObject)?.values?.get("live") as? JsonBoolean)?.value == false
}

sealed interface ArchiveConversationResult {
    data object Archived : ArchiveConversationResult
}
