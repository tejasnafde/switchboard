package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.WorktreeCreationCommand
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeLaunchAgent
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SwitchboardWorktreeCreationPortTest {
    @Test
    fun unavailablePairedBackendBlocksAStoredCreationWithAnActionableUpgradeError() {
        val port = UnavailableNewSessionWorktreeCreationPort("machine", 7)
        val outcomes = mutableListOf<RemoteOutcome<WorktreeCreationSnapshot?>>()

        port.get("creation-1") { outcomes += it.outcome }

        val failure = outcomes.single() as RemoteOutcome.Failure
        assertTrue(failure.message.contains("Update the paired Switchboard desktop"))
    }

    @Test
    fun ensureUsesTheVersionedAtomicEnvelopeAndDecodesTheAuthoritativeSnapshot() {
        val rpc = FakeWorktreeRpc().apply { responses += JsonCodec.parse(snapshotJson()) }
        val port = SwitchboardNewSessionWorktreeCreationPort(SwitchboardRemoteClient("machine", rpc))
        val responses = mutableListOf<WorktreeCreationSnapshot>()

        port.submit(WorktreeCreationCommand.Ensure(request())) { response ->
            (response.outcome as? RemoteOutcome.Success)?.value?.let(responses::add)
        }

        assertEquals("worktree-creation:create", rpc.calls.single().first)
        assertEquals(
            JsonCodec.parse("[$REQUEST_JSON]"),
            rpc.calls.single().second,
        )
        assertEquals("worktree-1", responses.single().worktreeId)
        assertEquals("thread-1", responses.single().startupReceipt?.providerThreadId)
    }

    @Test
    fun revisionCheckedActionsAndGetUseMachineScopedEnvelopes() {
        val rpc = FakeWorktreeRpc().apply {
            responses += JsonCodec.parse(snapshotJson())
            responses += JsonCodec.parse(snapshotJson())
        }
        val port = SwitchboardNewSessionWorktreeCreationPort(SwitchboardRemoteClient("machine", rpc))

        port.submit(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 7,
                action = WorktreeCreationRecoveryAction.Cancel,
            ),
        ) {}
        port.get("creation-1") {}

        assertEquals("worktree-creation:act", rpc.calls[0].first)
        assertEquals(
            JsonCodec.parse(
                """[{"creationId":"creation-1","machineId":"machine","expectedRevision":7,"action":"cancel"}]""",
            ),
            rpc.calls[0].second,
        )
        assertEquals("worktree-creation:get", rpc.calls[1].first)
        assertEquals(
            JsonCodec.parse("""[{"creationId":"creation-1","machineId":"machine"}]"""),
            rpc.calls[1].second,
        )
    }

    @Test
    fun setupChoiceActionsDecodeAndEncodeWithoutLosingTheirWireNames() {
        val rpc = FakeWorktreeRpc().apply {
            responses += JsonCodec.parse(
                snapshotJson().replace(
                    "\"recoveryActions\":[]",
                    "\"recoveryActions\":[\"choose_setup_run\",\"choose_setup_skip\"]",
                ),
            )
            responses += JsonCodec.parse(snapshotJson())
        }
        val port = SwitchboardNewSessionWorktreeCreationPort(SwitchboardRemoteClient("machine", rpc))
        val snapshots = mutableListOf<WorktreeCreationSnapshot>()

        port.get("creation-1") { response ->
            (response.outcome as? RemoteOutcome.Success)?.value?.let(snapshots::add)
        }
        port.submit(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 7,
                action = WorktreeCreationRecoveryAction.ChooseSetupSkip,
            ),
        ) {}

        assertEquals(
            listOf(
                WorktreeCreationRecoveryAction.ChooseSetupRun,
                WorktreeCreationRecoveryAction.ChooseSetupSkip,
            ),
            snapshots.single().recoveryActions,
        )
        assertEquals(
            JsonCodec.parse(
                """[{"creationId":"creation-1","machineId":"machine","expectedRevision":7,"action":"choose_setup_skip"}]""",
            ),
            rpc.calls.last().second,
        )
    }

    @Test
    fun cleanupDispositionSurvivesTheWireForRecoveryPresentation() {
        val rpc = FakeWorktreeRpc().apply {
            responses += JsonCodec.parse(
                snapshotJson().replace(
                    "\"recoveryActions\":[]",
                    "\"cleanupDisposition\":\"retained\",\"recoveryActions\":[]",
                ),
            )
        }
        val port = SwitchboardNewSessionWorktreeCreationPort(SwitchboardRemoteClient("machine", rpc))
        val snapshots = mutableListOf<WorktreeCreationSnapshot>()

        port.get("creation-1") { response ->
            (response.outcome as? RemoteOutcome.Success)?.value?.let(snapshots::add)
        }

        assertEquals(
            app.switchboard.mobile.domain.remote.WorktreeCleanupDisposition.Retained,
            snapshots.single().cleanupDisposition,
        )
    }

    @Test
    fun replayedProgressReconcilesTheCanonicalSnapshotBeforeNotifyingTheCoordinator() {
        val rpc = FakeWorktreeRpc().apply { responses += JsonCodec.parse(snapshotJson()) }
        val port = SwitchboardNewSessionWorktreeCreationPort(SwitchboardRemoteClient("machine", rpc))
        val observed = mutableListOf<WorktreeCreationSnapshot>()
        port.observe(observed::add)

        rpc.emit(
            "worktree-creation:progress",
            JsonCodec.parse(
                """[{"creationId":"creation-1","revision":7,"phase":"ready","status":"ready","timestamp":20,"recoveryActions":[]}]""",
            ) as JsonArray,
        )

        assertEquals(listOf("worktree-creation:get"), rpc.calls.map { it.first })
        assertEquals("creation-1", observed.single().creationId)
        assertEquals(7, observed.single().revision)
    }

    private fun request() = WorktreeCreationRequest(
        creationId = "creation-1",
        machineId = "machine",
        projectPath = "/repo",
        baseRef = "main",
        branchSeed = "thread-1",
        owner = WorktreeCreationOwner.Conversation("thread-1", "claude-code"),
        setupPolicy = WorktreeSetupPolicy.Inherit,
        launchAgent = WorktreeLaunchAgent(
            provider = "claude-code",
            runtimeMode = "sandbox",
            model = null,
            instanceId = null,
            prompt = "Fix it",
        ),
        requestedAt = 10,
    )

    private fun snapshotJson() =
        """{"creationId":"creation-1","revision":7,"phase":"ready","status":"ready","worktreeId":"worktree-1","projectPath":"/repo","worktreePath":"/worktrees/thread-1","branch":"sb/thread-1","baseRef":"main","owner":{"kind":"conversation","conversationId":"thread-1","agentType":"claude-code"},"purpose":"new-chat","provenance":{"surface":"android","machineId":"machine","requestedAt":10},"startupReceipt":{"status":"succeeded","terminalIds":[],"providerThreadId":"thread-1","initialPromptOrigin":"worktree-creation:creation-1"},"warnings":[],"recoveryActions":[],"updatedAt":20}"""

    private companion object {
        const val REQUEST_JSON =
            """{"schemaVersion":1,"creationId":"creation-1","repository":{"projectPath":"/repo","machineId":"machine"},"checkout":{"baseRef":"main","branch":{"namespace":"sb","seed":"thread-1"},"location":"managed-in-repo"},"owner":{"kind":"conversation","conversationId":"thread-1","agentType":"claude-code"},"purpose":"new-chat","setup":{"policy":"inherit"},"launch":{"initialAgent":{"provider":"claude-code","runtimeMode":"sandbox","prompt":"Fix it"}},"provenance":{"surface":"android","machineId":"machine","requestedAt":10}}"""
    }
}

private class FakeWorktreeRpc : RemoteRpc {
    override val scope = TransportScope("device", "machine", 7)
    val calls = mutableListOf<Pair<String, JsonArray>>()
    val responses = ArrayDeque<JsonValue?>()
    private val channelListeners = linkedMapOf<String, (TransportScope, JsonArray) -> Unit>()

    override fun invoke(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission {
        calls += channel to args
        callback(RpcOutcome.Success(responses.removeFirst()))
        return RequestSubmission.Accepted(calls.size.toLong(), expectedScope)
    }

    override fun onRuntimeEvent(
        listener: (TransportScope, RuntimeEventPayload) -> Unit,
    ): Cancelable = Cancelable {}

    override fun onChannelEvent(
        channel: String,
        listener: (TransportScope, JsonArray) -> Unit,
    ): Cancelable {
        channelListeners[channel] = listener
        return Cancelable { channelListeners.remove(channel) }
    }

    fun emit(channel: String, args: JsonArray) {
        assertTrue(channel in channelListeners)
        channelListeners.getValue(channel)(scope, args)
    }
}
