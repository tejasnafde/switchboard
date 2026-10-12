package app.switchboard.mobile.domain.remote

enum class WorktreeCreationPhase {
    Pending,
    Materializing,
    Configuring,
    Linking,
    AwaitingSetupDecision,
    Provisioning,
    Ready,
}

enum class WorktreeCreationStatus {
    Pending,
    Ready,
    Failed,
    RolledBack,
    CleanupRequired,
    Cancelled,
}

enum class WorktreeSetupPolicy { Inherit, Run, Skip }

enum class WorktreeCleanupDisposition { Retained, Removed, RemovalRefused }

enum class WorktreeCreationRecoveryAction {
    ChooseSetupRun,
    ChooseSetupSkip,
    Retry,
    Cancel,
    Retain,
    Remove,
    StartInProject,
}

sealed interface WorktreeCreationOwner {
    data class Conversation(
        val conversationId: String,
        val agentType: String,
    ) : WorktreeCreationOwner
}

data class WorktreeLaunchAgent(
    val provider: String,
    val runtimeMode: String,
    val model: String?,
    val instanceId: String?,
    val prompt: String?,
)

data class WorktreeCreationRequest(
    val creationId: String,
    val machineId: String,
    val projectPath: String,
    val baseRef: String,
    val branchSeed: String,
    val owner: WorktreeCreationOwner,
    val setupPolicy: WorktreeSetupPolicy,
    val launchAgent: WorktreeLaunchAgent,
    val requestedAt: Long,
    /** Check out this branch instead of creating one; needs `worktree_existing_branch_v1`. */
    val existingBranch: WorktreeExistingBranch? = null,
)

/**
 * `WorktreeExistingBranchIntent` in src/shared/worktree-creation.ts: a local
 * branch to check out, created from [fetch] when it does not exist yet.
 */
data class WorktreeExistingBranch(
    val name: String,
    val fetch: Fetch? = null,
) {
    /** Exactly one of [remote] and [repo]: the backend finds the remote pointing at [repo]. */
    data class Fetch(
        val ref: String,
        val repo: Repo? = null,
        val remote: String? = null,
    )

    data class Repo(
        val host: String,
        val owner: String,
        val name: String,
    )
}

data class WorktreeStartupReceipt(
    val status: Status,
    val terminalIds: List<String>,
    val providerThreadId: String?,
    val initialPromptOrigin: String?,
) {
    enum class Status { NotRequested, Running, Succeeded, Failed, Ambiguous }
}

data class WorktreeCreationError(
    val code: String,
    val message: String,
    val retryable: Boolean,
)

data class WorktreeCreationSnapshot(
    val creationId: String,
    val phase: WorktreeCreationPhase,
    val projectPath: String,
    val worktreeId: String?,
    val worktreePath: String?,
    val branch: String?,
    val baseRef: String,
    val owner: WorktreeCreationOwner,
    val status: WorktreeCreationStatus,
    val revision: Long,
    val startupReceipt: WorktreeStartupReceipt?,
    val recoveryActions: List<WorktreeCreationRecoveryAction>,
    val error: WorktreeCreationError? = null,
    val cleanupDisposition: WorktreeCleanupDisposition? = null,
)

sealed interface WorktreeCreationCommand {
    data class Ensure(val request: WorktreeCreationRequest) : WorktreeCreationCommand

    data class Act(
        val creationId: String,
        val expectedRevision: Long,
        val action: WorktreeCreationRecoveryAction,
    ) : WorktreeCreationCommand
}
