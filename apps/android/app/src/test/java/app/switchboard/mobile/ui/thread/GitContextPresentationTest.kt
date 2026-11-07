package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.remote.GitContextState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GitContextPresentationTest {
    @Test
    fun `worktree context keeps canonical parent cwd and branch distinct`() {
        val presentation = GitContextPresenter.present(
            projectPath = "/repo",
            worktreePath = "/repo/.switchboard/worktrees/native",
            state = GitContextState(branch = "sb/native", loaded = true),
        )

        assertEquals("sb/native · worktree", presentation.compactLabel)
        assertEquals("sb/native", presentation.branchLabel)
        assertEquals("Worktree", presentation.checkoutLabel)
        assertEquals("/repo/.switchboard/worktrees/native", presentation.checkoutPath)
        assertEquals("/repo", presentation.parentProjectPath)
        assertTrue(presentation.isWorktree)
    }

    @Test
    fun `main checkout and detached head are named without pretending to know a branch`() {
        val presentation = GitContextPresenter.present(
            projectPath = "/repo",
            worktreePath = null,
            state = GitContextState(branch = null, loaded = true),
        )

        assertEquals("Detached HEAD", presentation.branchLabel)
        assertEquals("detached · project", presentation.compactLabel)
        assertEquals("Project checkout", presentation.checkoutLabel)
        assertNull(presentation.parentProjectPath)
    }

    @Test
    fun `cached hint remains visible during refresh and failures stay actionable`() {
        val loading = GitContextPresenter.present(
            projectPath = "/repo",
            worktreePath = null,
            state = GitContextState(branch = "main", loading = true),
        )
        val failed = GitContextPresenter.present(
            projectPath = "/repo",
            worktreePath = null,
            state = GitContextState(branch = "main", error = "Machine disconnected"),
        )

        assertEquals("main · project", loading.compactLabel)
        assertTrue(loading.loading)
        assertEquals("Machine disconnected", failed.error)
        assertEquals("main", failed.branchLabel)
    }

    @Test
    fun `failed lookup without a hint does not pretend the checkout is detached`() {
        val failed = GitContextPresenter.present(
            projectPath = "/repo",
            worktreePath = null,
            state = GitContextState(loaded = true, error = "Machine disconnected"),
        )

        assertEquals("Branch unavailable", failed.branchLabel)
        assertEquals("unknown · project", failed.compactLabel)
    }

    @Test
    fun `the worktree fork is left out only where the folder has no HEAD`() {
        assertTrue(GitContextPresenter.offersWorktreeFork(GitContextState(branch = "main", loaded = true)))
        // Detached HEAD is still a work tree: a fork branches off that commit.
        assertTrue(GitContextPresenter.offersWorktreeFork(GitContextState(loaded = true)))
        assertFalse(
            GitContextPresenter.offersWorktreeFork(
                GitContextState(loaded = true, error = "fatal: not a git repository (or any of the parent directories)"),
            ),
        )
        assertFalse(GitContextPresenter.offersWorktreeFork(GitContextState(loaded = true, missing = true)))
        // A read that failed for another reason, or that has not answered,
        // keeps the choice: the backend refuses what it cannot serve.
        assertTrue(
            GitContextPresenter.offersWorktreeFork(
                GitContextState(loaded = true, error = "Machine connection was lost. Retry branch lookup."),
            ),
        )
        assertTrue(GitContextPresenter.offersWorktreeFork(GitContextState(loading = true)))
    }
}
