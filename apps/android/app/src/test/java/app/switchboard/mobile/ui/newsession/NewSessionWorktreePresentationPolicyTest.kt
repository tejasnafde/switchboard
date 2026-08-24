package app.switchboard.mobile.ui.newsession

import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.data.remote.NewSessionWorkspace
import app.switchboard.mobile.domain.remote.WorktreeCreationError
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationPhase
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeCreationStatus
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import app.switchboard.mobile.domain.remote.WorktreeCleanupDisposition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionWorktreePresentationPolicyTest {
    @Test
    fun freshWorktreeChoiceRequiresBackendCapability() {
        assertFalse(NewSessionWorktreePresentationPolicy.offersWorktreeChoice(state()))
        assertFalse(
            NewSessionWorktreePresentationPolicy.offersWorktreeChoice(
                state().copy(worktreeAvailable = false),
            ),
        )
        assertTrue(
            NewSessionWorktreePresentationPolicy.offersWorktreeChoice(
                state().copy(worktreeAvailable = true),
            ),
        )
    }

    @Test
    fun durableRecoveryKeepsWorktreeChoiceVisibleAcrossVersionSkew() {
        assertTrue(
            NewSessionWorktreePresentationPolicy.offersWorktreeChoice(
                state(
                    launchLocked = true,
                    record = record(
                        phase = WorktreeCreationPhase.Materializing,
                        status = WorktreeCreationStatus.Pending,
                        revision = 3,
                    ),
                ).copy(worktreeAvailable = false),
            ),
        )
    }

    @Test
    fun durableRecoveryRemainsVisibleBeforeTheFirstBackendSnapshotArrives() {
        assertTrue(
            NewSessionWorktreePresentationPolicy.offersWorktreeChoice(
                state(
                    launchLocked = true,
                ).copy(
                    worktreeAvailable = false,
                    workspace = NewSessionWorktreePresentationPolicy.newWorktree(),
                ),
            ),
        )
    }

    @Test
    fun workspaceSelectionDefaultsToTheCurrentCheckoutAndOffersAnIsolatedWorktree() {
        assertEquals(
            "Parent checkout",
            NewSessionWorktreePresentationPolicy.workspaceLabel(NewSessionWorkspace.ParentCheckout),
        )
        assertEquals(
            NewSessionWorkspace.Worktree(
                baseRef = "HEAD",
                setupPolicy = WorktreeSetupPolicy.Skip,
            ),
            NewSessionWorktreePresentationPolicy.newWorktree(),
        )
        assertEquals(
            "New worktree",
            NewSessionWorktreePresentationPolicy.workspaceLabel(
                NewSessionWorktreePresentationPolicy.newWorktree(),
            ),
        )
    }

    @Test
    fun parentCheckoutNeverPresentsWorktreeProgress() {
        assertNull(NewSessionWorktreePresentationPolicy.present(state()))
    }

    @Test
    fun correlatedSnapshotPhaseAndIdentityRemainVisibleWhilePending() {
        val presentation = NewSessionWorktreePresentationPolicy.present(
            state(
                launchLocked = true,
                submitting = true,
                record = record(
                    phase = WorktreeCreationPhase.Configuring,
                    status = WorktreeCreationStatus.Pending,
                    revision = 7,
                ),
            ),
        )!!

        assertEquals("Configuring worktree", presentation.title)
        assertEquals("Creation creation-1, revision 7", presentation.correlation)
        assertTrue(presentation.showProgress)
        assertTrue(presentation.canReconcile)
        assertFalse(presentation.canRetry)
        assertFalse(presentation.canStartInProject)
    }

    @Test
    fun recoveryButtonsAreDerivedOnlyFromTheBackendSnapshot() {
        val presentation = NewSessionWorktreePresentationPolicy.present(
            state(
                launchLocked = true,
                record = record(
                    phase = WorktreeCreationPhase.Provisioning,
                    status = WorktreeCreationStatus.Failed,
                    revision = 8,
                    recoveryActions = listOf(
                        WorktreeCreationRecoveryAction.ChooseSetupRun,
                        WorktreeCreationRecoveryAction.ChooseSetupSkip,
                        WorktreeCreationRecoveryAction.Retry,
                        WorktreeCreationRecoveryAction.Cancel,
                        WorktreeCreationRecoveryAction.Retain,
                        WorktreeCreationRecoveryAction.Remove,
                        WorktreeCreationRecoveryAction.StartInProject,
                    ),
                    error = WorktreeCreationError(
                        code = "SETUP_FAILED",
                        message = "Setup command failed",
                        retryable = true,
                    ),
                ),
            ),
        )!!

        assertEquals("Worktree creation failed", presentation.title)
        assertEquals("Setup command failed", presentation.detail)
        assertFalse(presentation.showProgress)
        assertTrue(presentation.canReconcile)
        assertTrue(presentation.canRetry)
        assertTrue(presentation.canCancel)
        assertTrue(presentation.canRunSetup)
        assertTrue(presentation.canSkipSetup)
        assertTrue(presentation.canRetain)
        assertTrue(presentation.canRemove)
        assertTrue(presentation.canStartInProject)
    }

    @Test
    fun localTransportErrorStillAllowsSameCreationReconciliation() {
        val presentation = NewSessionWorktreePresentationPolicy.present(
            state(
                launchLocked = true,
                submitting = false,
                error = "Connection lost",
            ),
        )!!

        assertEquals("Waiting for backend status", presentation.title)
        assertEquals("Connection lost", presentation.detail)
        assertFalse(presentation.showProgress)
        assertTrue(presentation.canReconcile)
        assertTrue(presentation.canRetry)
        assertFalse(presentation.canStartInProject)
    }

    @Test
    fun retainedCleanupIsPresentedAsACompletedUserDecision() {
        val presentation = NewSessionWorktreePresentationPolicy.present(
            state(
                launchLocked = true,
                record = record(
                    phase = WorktreeCreationPhase.Provisioning,
                    status = WorktreeCreationStatus.CleanupRequired,
                    revision = 9,
                ).copy(cleanupDisposition = WorktreeCleanupDisposition.Retained),
            ),
        )!!

        assertEquals("Worktree retained for recovery", presentation.title)
        assertFalse(presentation.canRetain)
        assertFalse(presentation.canRemove)
    }

    private fun state(
        launchLocked: Boolean = false,
        submitting: Boolean = false,
        error: String? = null,
        record: WorktreeCreationSnapshot? = null,
    ) = NewSessionState(
        connectionId = "machine",
        projectPath = "/repo",
        projectName = "Repo",
        loadingInstances = false,
        loadingDefaults = false,
        workspace = if (launchLocked || record != null || error != null) {
            NewSessionWorktreePresentationPolicy.newWorktree()
        } else {
            NewSessionWorkspace.ParentCheckout
        },
        launchLocked = launchLocked,
        submitting = submitting,
        worktreeRecord = record,
        error = error,
    )

    private fun record(
        phase: WorktreeCreationPhase,
        status: WorktreeCreationStatus,
        revision: Long,
        recoveryActions: List<WorktreeCreationRecoveryAction> = emptyList(),
        error: WorktreeCreationError? = null,
    ) = WorktreeCreationSnapshot(
        creationId = "creation-1",
        phase = phase,
        projectPath = "/repo",
        worktreeId = null,
        worktreePath = null,
        branch = null,
        baseRef = "HEAD",
        owner = WorktreeCreationOwner.Conversation("thread-1", "claude-code"),
        status = status,
        revision = revision,
        startupReceipt = null,
        recoveryActions = recoveryActions,
        error = error,
    )
}
