package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonObject

data class ForkConversationRequest(
    val requestId: String,
    val sourceConversationId: String,
    val raw: JsonObject,
)

data class ForkDirtySource(
    val headSha: String,
    val statusDigest: String,
    val trackedChanges: Long,
    val untrackedChanges: Long,
    val omittedChangeSummary: String,
)

data class ForkConversationState(
    val id: String,
    val projectPath: String,
    val worktreePath: String?,
    val worktreeBranch: String?,
    val worktreeId: String?,
    val agentType: String,
    val providerInstanceId: String?,
    val runtimeMode: String,
    val model: String?,
    val reasoningEffort: String?,
    val title: String,
    val parentConversationId: String,
    val parentTitle: String,
    val resumeMode: String,
    val anchorMessageId: String,
    val anchorPreview: String,
)

data class ForkConversationResult(
    val requestId: String,
    val conversation: ForkConversationState,
)

sealed interface ForkConversationOutcome {
    data class ConfirmationRequired(
        val requestId: String,
        val dirtySource: ForkDirtySource,
    ) : ForkConversationOutcome

    data class Completed(val result: ForkConversationResult) : ForkConversationOutcome

    data class Failed(
        val requestId: String,
        val code: String,
        val message: String,
        val retryable: Boolean,
        val retainedPath: String? = null,
        val retainedBranch: String? = null,
    ) : ForkConversationOutcome
}

data class ForkLineageMetadata(
    val parentConversationId: String,
    val parentTitle: String,
    val anchorMessageId: String,
    val anchorPreview: String,
    val resumeMode: String,
    val branch: String?,
    val baseSha: String?,
)
