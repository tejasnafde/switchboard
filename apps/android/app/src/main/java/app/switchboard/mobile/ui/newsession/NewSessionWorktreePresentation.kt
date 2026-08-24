package app.switchboard.mobile.ui.newsession

import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.data.remote.NewSessionWorkspace
import app.switchboard.mobile.domain.remote.WorktreeCleanupDisposition
import app.switchboard.mobile.domain.remote.WorktreeCreationPhase
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationStatus
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy

data class NewSessionWorktreePresentation(
    val title: String,
    val detail: String?,
    val correlation: String?,
    val showProgress: Boolean,
    val canReconcile: Boolean,
    val canRetry: Boolean,
    val canCancel: Boolean,
    val canRunSetup: Boolean,
    val canSkipSetup: Boolean,
    val canRetain: Boolean,
    val canRemove: Boolean,
    val canStartInProject: Boolean,
)

object NewSessionWorktreePresentationPolicy {
    fun offersWorktreeChoice(state: NewSessionState): Boolean =
        state.worktreeAvailable || state.worktreeRecord != null ||
            (state.launchLocked && state.workspace is NewSessionWorkspace.Worktree)

    fun newWorktree(): NewSessionWorkspace.Worktree = NewSessionWorkspace.Worktree(
        baseRef = "HEAD",
        setupPolicy = WorktreeSetupPolicy.Skip,
    )

    fun workspaceLabel(workspace: NewSessionWorkspace): String = when (workspace) {
        NewSessionWorkspace.ParentCheckout -> "Parent checkout"
        is NewSessionWorkspace.Worktree -> "New worktree"
    }

    fun present(state: NewSessionState): NewSessionWorktreePresentation? {
        if (state.workspace !is NewSessionWorkspace.Worktree) return null
        val record = state.worktreeRecord
        if (!state.launchLocked && record == null) return null
        val actions = record?.recoveryActions.orEmpty()
        return NewSessionWorktreePresentation(
            title = when (record?.status) {
                WorktreeCreationStatus.CleanupRequired -> when (record.cleanupDisposition) {
                    WorktreeCleanupDisposition.Retained -> "Worktree retained for recovery"
                    WorktreeCleanupDisposition.Removed -> "Worktree removed"
                    WorktreeCleanupDisposition.RemovalRefused -> "Worktree removal was refused"
                    null -> "Worktree cleanup required"
                }
                WorktreeCreationStatus.Failed -> "Worktree creation failed"
                WorktreeCreationStatus.RolledBack -> "Worktree creation rolled back"
                WorktreeCreationStatus.Cancelled -> "Worktree creation cancelled"
                else -> phaseLabel(record?.phase)
            },
            detail = record?.error?.message ?: state.error,
            correlation = record?.let { "Creation ${it.creationId}, revision ${it.revision}" },
            showProgress = state.submitting && record?.status != WorktreeCreationStatus.Failed,
            canReconcile = state.launchLocked,
            canRetry = WorktreeCreationRecoveryAction.Retry in actions ||
                (record == null && state.error != null),
            canCancel = WorktreeCreationRecoveryAction.Cancel in actions,
            canRunSetup = WorktreeCreationRecoveryAction.ChooseSetupRun in actions,
            canSkipSetup = WorktreeCreationRecoveryAction.ChooseSetupSkip in actions,
            canRetain = WorktreeCreationRecoveryAction.Retain in actions,
            canRemove = WorktreeCreationRecoveryAction.Remove in actions,
            canStartInProject = WorktreeCreationRecoveryAction.StartInProject in actions,
        )
    }

    private fun phaseLabel(phase: WorktreeCreationPhase?): String = when (phase) {
        null, WorktreeCreationPhase.Pending -> "Waiting for backend status"
        WorktreeCreationPhase.Materializing -> "Creating worktree"
        WorktreeCreationPhase.Configuring -> "Configuring worktree"
        WorktreeCreationPhase.Linking -> "Linking session"
        WorktreeCreationPhase.AwaitingSetupDecision -> "Waiting for setup choice"
        WorktreeCreationPhase.Provisioning -> "Starting agent"
        WorktreeCreationPhase.Ready -> "Confirming startup"
    }
}
