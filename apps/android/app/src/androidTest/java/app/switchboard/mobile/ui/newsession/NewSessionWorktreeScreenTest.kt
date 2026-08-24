package app.switchboard.mobile.ui.newsession

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.data.remote.NewSessionWorkspace
import app.switchboard.mobile.domain.remote.WorktreeCreationError
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationPhase
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeCreationStatus
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NewSessionWorktreeScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun workspaceSelectorOffersAnIsolatedWorktreeFromHead() {
        var selected: NewSessionWorkspace? = null
        setContent(onWorkspace = { selected = it })

        compose.onNodeWithContentDescription("Workspace").performClick()
        compose.onNodeWithText("New worktree").performClick()

        compose.runOnIdle {
            assertEquals(
                NewSessionWorkspace.Worktree("HEAD", WorktreeSetupPolicy.Skip),
                selected,
            )
        }
    }

    @Test
    fun workspaceSelectorHidesFreshWorktreeWhenBackendCapabilityIsUnavailable() {
        setContent(state = state(worktreeAvailable = false))

        compose.onNodeWithContentDescription("Workspace").performClick()

        compose.onNodeWithText("Parent checkout").assertIsDisplayed()
        compose.onNodeWithText("New worktree").assertDoesNotExist()
    }

    @Test
    fun workspaceSelectorKeepsPersistedRecoveryVisibleDuringVersionSkew() {
        setContent(
            state = state(
                launchLocked = true,
                worktreeAvailable = false,
                workspace = NewSessionWorkspace.Worktree("HEAD", WorktreeSetupPolicy.Inherit),
                worktreeRecord = failedRecord(),
            ),
        )

        compose.onNodeWithText("New worktree").assertIsDisplayed()
        compose.onNodeWithText("Worktree creation failed").assertIsDisplayed()
    }

    @Test
    fun failedSnapshotShowsOnlyAdvertisedRecoveryActionsAndCorrelation() {
        var reconciled = false
        var retried = false
        var startedInProject = false
        setContent(
            state = state(
                launchLocked = true,
                workspace = NewSessionWorkspace.Worktree("HEAD", WorktreeSetupPolicy.Inherit),
                worktreeRecord = failedRecord(),
                error = "Setup command failed",
            ),
            onReconcile = { reconciled = true },
            onRetry = { retried = true },
            onStartInProject = { startedInProject = true },
        )

        compose.onNodeWithText("Worktree creation failed").assertIsDisplayed()
        compose.onNodeWithText("Creation creation-1, revision 8").assertIsDisplayed()
        compose.onNodeWithText("Retry worktree creation").performScrollTo().performClick()
        compose.onNodeWithText("Check status").performScrollTo().performClick()
        compose.onNodeWithText("Start in project").performScrollTo().performClick()
        compose.onNodeWithText("Cancel worktree creation").assertDoesNotExist()

        compose.runOnIdle {
            assertTrue(retried)
            assertTrue(reconciled)
            assertTrue(startedInProject)
        }
    }

    @Test
    fun setupAndCleanupSnapshotsExposeTheirExactBackendActions() {
        var setupRun = false
        var setupSkipped = false
        var retained = false
        var removed = false
        setContent(
            state = state(
                launchLocked = true,
                workspace = NewSessionWorkspace.Worktree("HEAD", WorktreeSetupPolicy.Inherit),
                worktreeRecord = failedRecord().copy(
                    recoveryActions = listOf(
                        WorktreeCreationRecoveryAction.ChooseSetupRun,
                        WorktreeCreationRecoveryAction.ChooseSetupSkip,
                        WorktreeCreationRecoveryAction.Retain,
                        WorktreeCreationRecoveryAction.Remove,
                    ),
                ),
            ),
            onRunSetup = { setupRun = true },
            onSkipSetup = { setupSkipped = true },
            onRetain = { retained = true },
            onRemove = { removed = true },
        )

        compose.onNodeWithText("Run setup").performScrollTo().performClick()
        compose.onNodeWithText("Skip setup").performScrollTo().performClick()
        compose.onNodeWithText("Keep worktree").performScrollTo().performClick()
        compose.onNodeWithText("Remove worktree").performScrollTo().performClick()

        compose.runOnIdle {
            assertTrue(setupRun)
            assertTrue(setupSkipped)
            assertTrue(retained)
            assertTrue(removed)
        }
    }

    private fun setContent(
        state: NewSessionState = state(),
        onWorkspace: (NewSessionWorkspace) -> Unit = {},
        onReconcile: () -> Unit = {},
        onRetry: () -> Unit = {},
        onRunSetup: () -> Unit = {},
        onSkipSetup: () -> Unit = {},
        onRetain: () -> Unit = {},
        onRemove: () -> Unit = {},
        onStartInProject: () -> Unit = {},
    ) {
        compose.setContent {
            SwitchboardTheme {
                NewSessionScreen(
                    state = state,
                    onBack = {},
                    onProvider = {},
                    onRuntimeMode = {},
                    onInstance = {},
                    onModel = {},
                    onWorkspace = onWorkspace,
                    onFirstMessage = {},
                    onStart = {},
                    onReconcileWorktree = onReconcile,
                    onRetryWorktree = onRetry,
                    onRunWorktreeSetup = onRunSetup,
                    onSkipWorktreeSetup = onSkipSetup,
                    onRetainWorktree = onRetain,
                    onRemoveWorktree = onRemove,
                    onStartInProject = onStartInProject,
                    onCancelWorktree = {},
                )
            }
        }
    }

    private fun state(
        launchLocked: Boolean = false,
        worktreeAvailable: Boolean = true,
        workspace: NewSessionWorkspace = NewSessionWorkspace.ParentCheckout,
        worktreeRecord: WorktreeCreationSnapshot? = null,
        error: String? = null,
    ) = NewSessionState(
        connectionId = "machine",
        projectPath = "/repo",
        projectName = "Repo",
        loadingInstances = false,
        loadingDefaults = false,
        launchLocked = launchLocked,
        worktreeAvailable = worktreeAvailable,
        workspace = workspace,
        worktreeRecord = worktreeRecord,
        error = error,
    )

    private fun failedRecord() = WorktreeCreationSnapshot(
        creationId = "creation-1",
        phase = WorktreeCreationPhase.Materializing,
        projectPath = "/repo",
        worktreeId = null,
        worktreePath = null,
        branch = null,
        baseRef = "HEAD",
        owner = WorktreeCreationOwner.Conversation("thread-1", "claude-code"),
        status = WorktreeCreationStatus.Failed,
        revision = 8,
        startupReceipt = null,
        recoveryActions = listOf(
            WorktreeCreationRecoveryAction.Retry,
            WorktreeCreationRecoveryAction.StartInProject,
        ),
        error = WorktreeCreationError("SETUP_FAILED", "Setup command failed", retryable = true),
    )
}
