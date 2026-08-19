package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.CurrentBranchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.TransportScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GitContextCoordinatorTest {
    @Test
    fun `newer refresh wins and response must match the exact lease`() {
        val remote = FakeGitRemote()
        val coordinator = GitContextCoordinator(
            connectionId = "mac",
            expectedGeneration = 8,
            cwd = "/repo/worktree",
            branchHint = "hint",
            remote = remote,
        )

        coordinator.refresh()
        coordinator.refresh()
        remote.complete(0, success(generation = 8, branch = "stale"))
        assertTrue(coordinator.state.value.loading)
        remote.complete(1, success(generation = 7, branch = "wrong-lease"))
        assertTrue(coordinator.state.value.loading)

        coordinator.refresh()
        remote.complete(2, success(generation = 8, branch = "feature/native"))

        assertFalse(coordinator.state.value.loading)
        assertEquals("feature/native", coordinator.state.value.branch)
        assertEquals(null, coordinator.state.value.error)
    }

    @Test
    fun `domain failure preserves branch hint and exposes retryable detail`() {
        val remote = FakeGitRemote()
        val coordinator = GitContextCoordinator(
            connectionId = "mac",
            expectedGeneration = 3,
            cwd = "/repo",
            branchHint = "cached-branch",
            remote = remote,
        )
        coordinator.refresh()
        remote.complete(
            0,
            RemoteResponse(
                RemoteRequestKey("mac", 3, BackendChannels.CurrentBranch),
                RemoteOutcome.Success(CurrentBranchResult.Unavailable("Not a git repository", false)),
            ),
        )

        assertEquals("cached-branch", coordinator.state.value.branch)
        assertEquals("Not a git repository", coordinator.state.value.error)
        assertFalse(coordinator.state.value.loading)
    }

    @Test
    fun `synchronous submission rejection never leaves loading stuck`() {
        val coordinator = GitContextCoordinator(
            connectionId = "mac",
            expectedGeneration = 3,
            cwd = "/repo",
            branchHint = null,
            remote = GitContextRemote { _, _ -> RequestSubmission.Rejected(RpcFailure.NotReady) },
        )

        coordinator.refresh()

        assertFalse(coordinator.state.value.loading)
        assertEquals("Machine is not ready. Retry branch lookup.", coordinator.state.value.error)
    }

    private fun success(generation: Long, branch: String?): RemoteResponse<CurrentBranchResult> = RemoteResponse(
        RemoteRequestKey("mac", generation, BackendChannels.CurrentBranch),
        RemoteOutcome.Success(CurrentBranchResult.Available(branch)),
    )

    private class FakeGitRemote : GitContextRemote {
        private val callbacks = mutableListOf<(RemoteResponse<CurrentBranchResult>) -> Unit>()

        override fun currentBranch(
            cwd: String,
            callback: (RemoteResponse<CurrentBranchResult>) -> Unit,
        ): RequestSubmission {
            callbacks += callback
            return RequestSubmission.Accepted(callbacks.size.toLong(), TransportScope("phone", "mac", 8))
        }

        fun complete(index: Int, response: RemoteResponse<CurrentBranchResult>) {
            callbacks[index](response)
        }
    }
}
