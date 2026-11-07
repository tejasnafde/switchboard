package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.remote.GitContextState

data class GitContextPresentation(
    val compactLabel: String,
    val branchLabel: String,
    val checkoutLabel: String,
    val checkoutPath: String,
    val parentProjectPath: String?,
    val isWorktree: Boolean,
    val loading: Boolean,
    val error: String?,
)

object GitContextPresenter {
    /**
     * Whether to offer "fork into a new worktree". A folder that is not a git
     * work tree has no HEAD to branch from, and neither has a folder that is
     * gone, so the choice is left out. Only an answer that proves one of those
     * drops it: a read that failed for another reason, or that has not
     * answered, keeps the choice, and the backend refuses a request it cannot
     * serve. Mirrors `offerForkIntoWorktree` in `src/shared/conversation-fork.ts`.
     */
    fun offersWorktreeFork(state: GitContextState): Boolean =
        !(state.missing || state.error?.contains("not a git repository", ignoreCase = true) == true)

    fun present(
        projectPath: String,
        worktreePath: String?,
        state: GitContextState,
    ): GitContextPresentation {
        val worktree = worktreePath?.takeIf(String::isNotBlank)
        val branchLabel = when {
            !state.branch.isNullOrBlank() -> state.branch
            state.error != null -> "Branch unavailable"
            state.loaded -> "Detached HEAD"
            else -> "Checking branch"
        }
        val compactBranch = when (branchLabel) {
            "Detached HEAD" -> "detached"
            "Checking branch" -> "branch…"
            "Branch unavailable" -> "unknown"
            else -> branchLabel
        }
        val location = if (worktree != null) "worktree" else "project"
        return GitContextPresentation(
            compactLabel = "$compactBranch · $location",
            branchLabel = branchLabel,
            checkoutLabel = if (worktree != null) "Worktree" else "Project checkout",
            checkoutPath = worktree ?: projectPath,
            parentProjectPath = projectPath.takeIf { worktree != null && it != worktree },
            isWorktree = worktree != null,
            loading = state.loading,
            error = state.error,
        )
    }
}
