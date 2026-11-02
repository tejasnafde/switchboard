package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.CurrentBranchResult
import app.switchboard.mobile.domain.remote.RemoteDecoders
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.thread.BranchName
import app.switchboard.mobile.domain.thread.DetailsRead
import app.switchboard.mobile.domain.thread.DiffStat
import app.switchboard.mobile.domain.thread.UsageLimits
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatDetailsCoordinatorTest {
    @Test
    fun `an open reads the branch, the diff stat and the usage limits`() {
        val remote = FakeDetailsRemote()
        val coordinator = ChatDetailsCoordinator(expectedGeneration = 4, cwd = "/repo/wt", remote = remote)

        coordinator.refresh("claude-work")
        assertTrue(coordinator.state.value.usageReading)
        assertEquals(listOf("/repo/wt", "/repo/wt", "claude-work"), remote.args)

        remote.branch.single()(response(4, CurrentBranchResult.Available("feat/x")))
        remote.diff.single()(response(4, DiffStat(14, 3)))
        remote.usage.single()(response(4, UsageLimits(85.0, null)))

        val state = coordinator.state.value
        assertEquals(DetailsRead.Read(BranchName("feat/x")), state.branch)
        assertEquals(DetailsRead.Read(DiffStat(14, 3)), state.diff)
        assertEquals(UsageLimits(85.0, null), state.usage)
        assertFalse(state.usageReading)
    }

    @Test
    fun `a stale open or another connection generation is dropped`() {
        val remote = FakeDetailsRemote()
        val coordinator = ChatDetailsCoordinator(expectedGeneration = 4, cwd = "/repo", remote = remote)
        coordinator.refresh("a")
        coordinator.refresh("a")
        remote.branch[0](response(4, CurrentBranchResult.Available("stale")))
        remote.branch[1](response(3, CurrentBranchResult.Available("old-lease")))
        assertEquals(DetailsRead.Reading, coordinator.state.value.branch)

        coordinator.close()
        remote.diff[1](response(4, DiffStat(1, 1)))
        assertEquals(DetailsRead.Reading, coordinator.state.value.diff)
    }

    @Test
    fun `failed reads show None and Unavailable`() {
        val remote = FakeDetailsRemote()
        val coordinator = ChatDetailsCoordinator(expectedGeneration = 1, cwd = "/tmp", remote = remote)
        coordinator.refresh("a")
        remote.branch.single()(response(1, CurrentBranchResult.Unavailable("not a git repository", false)))
        remote.diff.single()(response<DiffStat?>(1, null))
        remote.usage.single()(RemoteResponse(key(1), RemoteOutcome.Failure("timeout")))

        val state = coordinator.state.value
        assertEquals(DetailsRead.Failed, state.branch)
        assertEquals(DetailsRead.Failed, state.diff)
        assertNull(state.usage)
        assertFalse(state.usageReading)
    }

    @Test
    fun `a request the client never sent fails at once`() {
        val remote = FakeDetailsRemote(submission = RequestSubmission.Rejected(RpcFailure.NotReady))
        val coordinator = ChatDetailsCoordinator(expectedGeneration = 1, cwd = "/repo", remote = remote)
        coordinator.refresh("a")
        assertEquals(DetailsRead.Failed, coordinator.state.value.branch)
        assertEquals(DetailsRead.Failed, coordinator.state.value.diff)
        assertFalse(coordinator.state.value.usageReading)
    }

    @Test
    fun `decoders read the diff stat and the weekly and 5-hour windows`() {
        assertEquals(DiffStat(14, 3), RemoteDecoders.diffStat(JsonCodec.parse("""{"ok":true,"added":14,"removed":3}""")))
        assertNull(RemoteDecoders.diffStat(JsonCodec.parse("""{"ok":false,"error":"not a git repository"}""")))
        assertEquals(
            UsageLimits(weeklyUsed = 85.5, sessionUsed = 12.0),
            RemoteDecoders.usageLimits(
                JsonCodec.parse(
                    """{"status":"ok","windows":[{"kind":"session","usedPercent":12},""" +
                        """{"kind":"weekly","usedPercent":85.5},{"kind":"model","usedPercent":99}]}""",
                ),
            ),
        )
        assertEquals(
            UsageLimits(weeklyUsed = null, sessionUsed = null),
            RemoteDecoders.usageLimits(JsonCodec.parse("""{"status":"ok","windows":[{"kind":"weekly","usedPercent":null}]}""")),
        )
        assertNull(RemoteDecoders.usageLimits(JsonCodec.parse("""{"status":"unsupported","windows":[]}""")))
    }

    private fun key(generation: Long) = RemoteRequestKey("mac", generation, "op")

    private fun <T> response(generation: Long, value: T) = RemoteResponse(key(generation), RemoteOutcome.Success(value))

    private class FakeDetailsRemote(
        private val submission: RequestSubmission = RequestSubmission.Accepted(1, TransportScope("d", "mac", 1)),
    ) : ChatDetailsRemote {
        val args = mutableListOf<String>()
        val branch = mutableListOf<(RemoteResponse<CurrentBranchResult>) -> Unit>()
        val diff = mutableListOf<(RemoteResponse<DiffStat?>) -> Unit>()
        val usage = mutableListOf<(RemoteResponse<UsageLimits?>) -> Unit>()

        override fun currentBranch(cwd: String, callback: (RemoteResponse<CurrentBranchResult>) -> Unit): RequestSubmission {
            args += cwd
            branch += callback
            return submission
        }

        override fun diffStat(cwd: String, callback: (RemoteResponse<DiffStat?>) -> Unit): RequestSubmission {
            args += cwd
            diff += callback
            return submission
        }

        override fun instanceUsage(instanceId: String, callback: (RemoteResponse<UsageLimits?>) -> Unit): RequestSubmission {
            args += instanceId
            usage += callback
            return submission
        }
    }
}
