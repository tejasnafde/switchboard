package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.remote.StartedSession
import app.switchboard.mobile.domain.remote.WorktreeCreationCommand
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationPhase
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeCreationStatus
import app.switchboard.mobile.domain.remote.WorktreeLaunchAgent
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import app.switchboard.mobile.domain.remote.WorktreeStartupReceipt
import app.switchboard.mobile.protocol.JsonNull
import java.io.Closeable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionWorktreeCreationContractTest {
    @Test
    fun retryableRollbackSurvivesProcessRecreationWithTheExactDurableRequest() {
        val store = MemoryWorktreeStore().apply { save(request()) {} }
        val firstPort = FakeWorktreePort()
        val first = coordinator(
            remote = FakeRemote(),
            worktrees = firstPort,
            store = store,
            creationIds = WorktreeCreationIdSource {
                error("recovery must not allocate another creationId")
            },
        )
        first.load()
        firstPort.answerGet(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.RolledBack,
                revision = 6,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.Retry),
            ),
        )

        assertEquals(listOf(request()), store.saved)
        first.close()

        val recreatedPort = FakeWorktreePort()
        val recreated = coordinator(
            remote = FakeRemote(),
            worktrees = recreatedPort,
            store = store,
            creationIds = WorktreeCreationIdSource {
                error("process recreation must reuse the durable creationId")
            },
        )
        recreated.load()

        assertEquals(listOf("creation-1"), recreatedPort.gets)
        assertTrue(recreatedPort.commands.isEmpty())

        recreatedPort.answerGet(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.RolledBack,
                revision = 6,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.Retry),
            ),
        )
        recreated.retryWorktreeCreation()

        assertEquals(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 6,
                action = WorktreeCreationRecoveryAction.Retry,
            ),
            recreatedPort.commands.single(),
        )
    }

    @Test
    fun terminalRollbackWithoutRecoveryActionsClearsTheDurableRequest() {
        val store = MemoryWorktreeStore().apply { save(request()) {} }
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(
            remote = FakeRemote(),
            worktrees = worktrees,
            store = store,
        )
        coordinator.load()

        worktrees.answerGet(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.RolledBack,
                revision = 6,
            ),
        )

        assertTrue(store.saved.isEmpty())
    }

    @Test
    fun unavailableCapabilityRejectsFreshWorktreeIntent() {
        val coordinator = coordinator(
            remote = FakeRemote(),
            worktrees = FakeWorktreePort(),
            worktreeAvailable = false,
        )

        coordinator.selectWorkspace(worktreeWorkspace())

        assertEquals(NewSessionWorkspace.ParentCheckout, coordinator.state.value.workspace)
        assertTrue(!coordinator.state.value.worktreeAvailable)
    }

    @Test
    fun unavailableCapabilityDoesNotDiscardDurableProcessRecovery() {
        val store = MemoryWorktreeStore().apply { save(request()) {} }
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(
            remote = FakeRemote(),
            worktrees = worktrees,
            store = store,
            creationIds = WorktreeCreationIdSource {
                error("recovery must preserve the saved creationId")
            },
            worktreeAvailable = false,
        )

        coordinator.load()

        assertTrue(!coordinator.state.value.worktreeAvailable)
        assertEquals(worktreeWorkspace(), coordinator.state.value.workspace)
        assertEquals(listOf("creation-1"), worktrees.gets)
        assertTrue(worktrees.commands.isEmpty())
    }

    @Test
    fun backendSubmissionWaitsForTheDurableLocalJournalWrite() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val store = DelayedWorktreeStore()
        val coordinator = coordinator(remote = remote, worktrees = worktrees, store = store)
        coordinator.selectWorkspace(worktreeWorkspace())

        coordinator.submit()

        assertEquals("creation-1", store.pending?.creationId)
        assertTrue(worktrees.commands.isEmpty())
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())

        store.completeSave()

        assertEquals(
            WorktreeCreationCommand.Ensure(store.pending!!),
            worktrees.commands.single(),
        )
    }

    @Test
    fun retryUsesTheFailedSnapshotRevisionAndProcessRecreationKeepsTheDurableCreationId() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val store = MemoryWorktreeStore()
        val first = coordinator(
            remote = remote,
            worktrees = worktrees,
            store = store,
            creationIds = WorktreeCreationIdSource { "creation-1" },
        )
        first.selectWorkspace(worktreeWorkspace())
        first.updateFirstMessage("Fix the bug")

        first.submit()
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())
        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.Failed,
                revision = 2,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.Retry),
            ),
        )
        first.retryWorktreeCreation()

        val saved = store.saved.single()
        assertEquals("creation-1", saved.creationId)
        assertEquals("machine", saved.machineId)
        assertEquals("/repo", saved.projectPath)
        assertEquals("main", saved.baseRef)
        assertEquals(
            WorktreeCreationOwner.Conversation(
                conversationId = "thread-1",
                agentType = "claude-code",
            ),
            saved.owner,
        )
        assertEquals(WorktreeSetupPolicy.Inherit, saved.setupPolicy)
        assertEquals(
            WorktreeLaunchAgent(
                provider = "claude-code",
                runtimeMode = "sandbox",
                model = null,
                instanceId = null,
                prompt = "Fix the bug",
            ),
            saved.launchAgent,
        )
        assertEquals(WorktreeCreationCommand.Ensure(saved), worktrees.commands.first())
        assertEquals(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 2,
                action = WorktreeCreationRecoveryAction.Retry,
            ),
            worktrees.commands.last(),
        )

        val recreatedPort = FakeWorktreePort()
        val recreated = coordinator(
            remote = FakeRemote(),
            worktrees = recreatedPort,
            store = store,
            creationIds = WorktreeCreationIdSource {
                error("process recovery must not allocate another creationId")
            },
        )

        recreated.load()

        assertEquals(listOf("creation-1"), recreatedPort.gets)
        assertTrue(recreatedPort.commands.isEmpty())

        recreatedPort.answerGet(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.Failed,
                revision = 5,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.Retry),
            ),
        )
        recreated.retryWorktreeCreation()

        assertEquals(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 5,
                action = WorktreeCreationRecoveryAction.Retry,
            ),
            recreatedPort.commands.single(),
        )
    }

    @Test
    fun requestPreservesAnExplicitSkipSetupPolicy() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val store = MemoryWorktreeStore()
        val coordinator = coordinator(remote = remote, worktrees = worktrees, store = store)
        coordinator.selectWorkspace(worktreeWorkspace(setupPolicy = WorktreeSetupPolicy.Skip))

        coordinator.submit()

        assertEquals(WorktreeSetupPolicy.Skip, store.saved.single().setupPolicy)
        assertEquals(
            WorktreeCreationCommand.Ensure(store.saved.single()),
            worktrees.commands.single(),
        )
    }

    @Test
    fun ambiguousCreateDisconnectReconcilesWithGetInsteadOfCreatingAgain() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val started = mutableListOf<NewSessionStarted>()
        val coordinator = coordinator(remote = remote, worktrees = worktrees, onStarted = started::add)
        coordinator.selectWorkspace(worktreeWorkspace())

        coordinator.submit()
        worktrees.failSubmit("Connection lost after request submission")

        assertEquals(1, worktrees.commands.filterIsInstance<WorktreeCreationCommand.Ensure>().size)
        assertEquals(listOf("creation-1"), worktrees.gets)
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())
        assertTrue(started.isEmpty())

        worktrees.answerGet(readyRecord(revision = 4))

        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())
        assertEquals("thread-1", started.single().threadId)
        assertEquals("/worktrees/thread-1", started.single().worktreePath)
        assertEquals("sb/thread-1", started.single().branch)
        assertEquals("worktree-1", started.single().worktreeId)
        assertEquals("creation-1", started.single().creationId)
        assertEquals(1, worktrees.commands.filterIsInstance<WorktreeCreationCommand.Ensure>().size)
    }

    @Test
    fun retryDuringAmbiguousTransportQueriesAgainWithoutBlindlyResubmitting() {
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(remote = FakeRemote(), worktrees = worktrees)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.submit()
        worktrees.failSubmit("Connection lost after request submission")

        coordinator.retryWorktreeCreation()

        assertEquals(1, worktrees.commands.filterIsInstance<WorktreeCreationCommand.Ensure>().size)
        assertEquals(listOf("creation-1", "creation-1"), worktrees.gets)
    }

    @Test
    fun processRecoveryMayEnsureTheExactSavedRequestOnlyAfterGetProvesItIsAbsent() {
        val store = MemoryWorktreeStore().apply {
            save(request()) {}
        }
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(
            remote = FakeRemote(),
            worktrees = worktrees,
            store = store,
            creationIds = WorktreeCreationIdSource {
                error("recovery must preserve the saved creationId")
            },
        )
        coordinator.load()
        worktrees.answerGet(null)

        coordinator.retryWorktreeCreation()

        assertEquals(WorktreeCreationCommand.Ensure(request()), worktrees.commands.single())
        assertEquals("creation-1", store.saved.single().creationId)
    }

    @Test
    fun explicitReconcileQueriesTheSameDurableCreationWithoutResubmitting() {
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(remote = FakeRemote(), worktrees = worktrees)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.submit()
        worktrees.answerSubmit(pendingRecord(revision = 1))

        coordinator.reconcileWorktreeCreation()

        assertEquals(listOf("creation-1"), worktrees.gets)
        assertEquals(1, worktrees.commands.filterIsInstance<WorktreeCreationCommand.Ensure>().size)
    }

    @Test
    fun progressUsesCreationIdAndMonotonicRevisionCorrelation() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(remote = remote, worktrees = worktrees)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.submit()
        worktrees.answerSubmit(pendingRecord(revision = 1))

        worktrees.emit(readyRecord(creationId = "another-creation", revision = 99))
        assertEquals(WorktreeCreationPhase.Pending, coordinator.state.value.worktreeRecord?.phase)

        worktrees.emit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Configuring,
                status = WorktreeCreationStatus.Pending,
                revision = 3,
            ),
        )
        assertEquals(WorktreeCreationPhase.Configuring, coordinator.state.value.worktreeRecord?.phase)

        worktrees.emit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.Pending,
                revision = 2,
            ),
        )
        assertEquals(WorktreeCreationPhase.Configuring, coordinator.state.value.worktreeRecord?.phase)
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())
    }

    @Test
    fun navigationWaitsForAuthoritativeReadyAndStartupMetadata() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val started = mutableListOf<NewSessionStarted>()
        val coordinator = coordinator(
            remote = remote,
            worktrees = worktrees,
            onStarted = started::add,
        )
        coordinator.selectWorkspace(worktreeWorkspace())

        coordinator.submit()
        worktrees.answerSubmit(pendingRecord(revision = 1))
        assertTrue(remote.starts.isEmpty())
        assertTrue(started.isEmpty())
        listOf(
            WorktreeCreationPhase.Materializing,
            WorktreeCreationPhase.Configuring,
            WorktreeCreationPhase.Linking,
            WorktreeCreationPhase.Provisioning,
        ).forEachIndexed { index, phase ->
            worktrees.emit(
                record(
                    creationId = "creation-1",
                    phase = phase,
                    status = WorktreeCreationStatus.Pending,
                    revision = index.toLong() + 2,
                ),
            )
            assertTrue(remote.starts.isEmpty())
            assertTrue(started.isEmpty())
        }

        worktrees.emit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Ready,
                status = WorktreeCreationStatus.Ready,
                revision = 6,
            ),
        )
        assertTrue(remote.starts.isEmpty())
        assertTrue(started.isEmpty())

        worktrees.emit(readyRecord(revision = 7))

        assertEquals("/worktrees/thread-1", started.single().worktreePath)
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())
    }

    @Test
    fun failedWorktreeFallsBackOnlyWhenTheBackendAdvertisesStartInProject() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val store = MemoryWorktreeStore()
        val coordinator = coordinator(remote = remote, worktrees = worktrees, store = store)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.updateFirstMessage("Preserve this prompt")
        coordinator.submit()

        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.Failed,
                revision = 2,
            ),
        )

        assertTrue(remote.starts.isEmpty())
        assertEquals(WorktreeCreationStatus.Failed, coordinator.state.value.worktreeRecord?.status)

        coordinator.useParentCheckout()

        assertEquals(1, worktrees.commands.size)
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())

        worktrees.emit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Materializing,
                status = WorktreeCreationStatus.Failed,
                revision = 3,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.StartInProject),
            ),
        )
        coordinator.useParentCheckout()

        assertEquals(1, worktrees.commands.size)
        assertEquals("thread-1", remote.creates.single().first.id)
        assertEquals("/repo", remote.creates.single().first.projectPath)
        assertEquals(NewSessionWorkspace.ParentCheckout, coordinator.state.value.workspace)
        assertEquals("Preserve this prompt", coordinator.state.value.firstMessage)
        assertTrue(store.saved.isEmpty())
        assertTrue(remote.starts.isEmpty())

        remote.creates.single().second(success("create", CommandBody(JsonNull)))

        val start = remote.starts.single().first
        assertEquals("thread-1", start.threadId)
        assertEquals("claude", start.provider.wire)
        assertEquals("/repo", start.cwd)
        assertEquals("sandbox", start.runtimeMode?.wire)
    }

    @Test
    fun cancellationIsSubmittedOnlyWhenTheBackendAdvertisesItAsSafe() {
        val remote = FakeRemote()
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(remote = remote, worktrees = worktrees)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.submit()
        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Provisioning,
                status = WorktreeCreationStatus.Failed,
                revision = 4,
            ),
        )

        coordinator.cancelWorktreeCreation()
        assertEquals(1, worktrees.commands.size)

        worktrees.emit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Provisioning,
                status = WorktreeCreationStatus.Failed,
                revision = 5,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.Cancel),
            ),
        )
        coordinator.cancelWorktreeCreation()

        assertEquals(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 5,
                action = WorktreeCreationRecoveryAction.Cancel,
            ),
            worktrees.commands.last(),
        )
        assertTrue(remote.creates.isEmpty())
        assertTrue(remote.starts.isEmpty())
    }

    @Test
    fun unavailableRetryActionDoesNotLeaveTheCoordinatorLookingBusy() {
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(remote = FakeRemote(), worktrees = worktrees)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.submit()
        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Provisioning,
                status = WorktreeCreationStatus.Failed,
                revision = 4,
            ),
        )

        coordinator.retryWorktreeCreation()

        assertEquals(1, worktrees.commands.size)
        assertTrue(!coordinator.state.value.submitting)
    }

    @Test
    fun setupChoicesAndRetainedWorktreeActionsUseTheAdvertisedSnapshotRevision() {
        val worktrees = FakeWorktreePort()
        val coordinator = coordinator(remote = FakeRemote(), worktrees = worktrees)
        coordinator.selectWorkspace(worktreeWorkspace())
        coordinator.submit()
        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.AwaitingSetupDecision,
                status = WorktreeCreationStatus.Pending,
                revision = 4,
                recoveryActions = listOf(
                    WorktreeCreationRecoveryAction.ChooseSetupRun,
                    WorktreeCreationRecoveryAction.ChooseSetupSkip,
                ),
            ),
        )

        coordinator.chooseWorktreeSetup(run = true)

        assertEquals(
            WorktreeCreationCommand.Act(
                creationId = "creation-1",
                expectedRevision = 4,
                action = WorktreeCreationRecoveryAction.ChooseSetupRun,
            ),
            worktrees.commands.last(),
        )

        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Provisioning,
                status = WorktreeCreationStatus.CleanupRequired,
                revision = 6,
                recoveryActions = listOf(
                    WorktreeCreationRecoveryAction.Retain,
                    WorktreeCreationRecoveryAction.Remove,
                ),
            ),
        )
        coordinator.retainWorktree()
        worktrees.answerSubmit(
            record(
                creationId = "creation-1",
                phase = WorktreeCreationPhase.Provisioning,
                status = WorktreeCreationStatus.CleanupRequired,
                revision = 7,
                recoveryActions = listOf(WorktreeCreationRecoveryAction.Remove),
            ),
        )
        coordinator.removeWorktree()

        assertEquals(
            listOf(
                WorktreeCreationRecoveryAction.ChooseSetupRun to 4L,
                WorktreeCreationRecoveryAction.Retain to 6L,
                WorktreeCreationRecoveryAction.Remove to 7L,
            ),
            worktrees.commands.drop(1).map { command ->
                val action = command as WorktreeCreationCommand.Act
                action.action to action.expectedRevision
            },
        )
    }

    private fun coordinator(
        remote: FakeRemote,
        worktrees: FakeWorktreePort,
        store: NewSessionWorktreeCreationStore = MemoryWorktreeStore(),
        creationIds: WorktreeCreationIdSource = WorktreeCreationIdSource { "creation-1" },
        onStarted: (NewSessionStarted) -> Unit = {},
        worktreeAvailable: Boolean = true,
    ) = NewSessionCoordinator(
        connectionId = "machine",
        generation = 7,
        projectPath = "/repo",
        projectName = "Repo",
        remote = remote,
        enqueue = NewSessionEnqueue {
            error("the backend transaction owns the worktree launch's initial prompt")
        },
        ids = NewSessionIdSource { "thread-1" },
        clock = NewSessionClock { 10 },
        onStarted = onStarted,
        worktrees = worktrees,
        worktreeStore = store,
        creationIds = creationIds,
        worktreeAvailable = worktreeAvailable,
    )

    private fun worktreeWorkspace(
        setupPolicy: WorktreeSetupPolicy = WorktreeSetupPolicy.Inherit,
    ) = NewSessionWorkspace.Worktree(
        baseRef = "main",
        setupPolicy = setupPolicy,
    )

    private fun request() = WorktreeCreationRequest(
        creationId = "creation-1",
        machineId = "machine",
        projectPath = "/repo",
        baseRef = "main",
        branchSeed = "Repo",
        owner = WorktreeCreationOwner.Conversation("thread-1", "claude-code"),
        setupPolicy = WorktreeSetupPolicy.Inherit,
        launchAgent = WorktreeLaunchAgent(
            provider = "claude-code",
            runtimeMode = "sandbox",
            model = null,
            instanceId = null,
            prompt = null,
        ),
        requestedAt = 10,
    )

    private fun record(
        creationId: String,
        phase: WorktreeCreationPhase,
        status: WorktreeCreationStatus,
        revision: Long,
        worktreeId: String? = null,
        worktreePath: String? = null,
        branch: String? = null,
        startupReceipt: WorktreeStartupReceipt? = null,
        recoveryActions: List<WorktreeCreationRecoveryAction> = emptyList(),
    ) = WorktreeCreationSnapshot(
        creationId = creationId,
        phase = phase,
        projectPath = "/repo",
        worktreeId = worktreeId,
        worktreePath = worktreePath,
        branch = branch,
        baseRef = "main",
        owner = WorktreeCreationOwner.Conversation(
            conversationId = "thread-1",
            agentType = "claude-code",
        ),
        status = status,
        revision = revision,
        startupReceipt = startupReceipt,
        recoveryActions = recoveryActions,
    )

    private fun pendingRecord(revision: Long) = record(
        creationId = "creation-1",
        phase = WorktreeCreationPhase.Pending,
        status = WorktreeCreationStatus.Pending,
        revision = revision,
    )

    private fun readyRecord(
        creationId: String = "creation-1",
        revision: Long,
    ) = record(
        creationId = creationId,
        phase = WorktreeCreationPhase.Ready,
        status = WorktreeCreationStatus.Ready,
        revision = revision,
        worktreeId = "worktree-1",
        worktreePath = "/worktrees/thread-1",
        branch = "sb/thread-1",
        startupReceipt = WorktreeStartupReceipt(
            status = WorktreeStartupReceipt.Status.Succeeded,
            terminalIds = emptyList(),
            providerThreadId = "thread-1",
            initialPromptOrigin = "worktree-creation:creation-1",
        ),
    )

    private fun <T> success(operation: String, value: T) = RemoteResponse(
        RemoteRequestKey("machine", 7, operation),
        RemoteOutcome.Success(value),
    )

    private inner class FakeWorktreePort : NewSessionWorktreeCreationPort {
        val commands = mutableListOf<WorktreeCreationCommand>()
        val gets = mutableListOf<String>()
        private val submitCallbacks = ArrayDeque<(RemoteResponse<WorktreeCreationSnapshot>) -> Unit>()
        private val getCallbacks = ArrayDeque<(RemoteResponse<WorktreeCreationSnapshot?>) -> Unit>()
        private val observers = mutableListOf<(WorktreeCreationSnapshot) -> Unit>()

        override fun submit(
            command: WorktreeCreationCommand,
            callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
        ) {
            commands += command
            submitCallbacks += callback
        }

        override fun get(
            creationId: String,
            callback: (RemoteResponse<WorktreeCreationSnapshot?>) -> Unit,
        ) {
            gets += creationId
            getCallbacks += callback
        }

        override fun observe(observer: (WorktreeCreationSnapshot) -> Unit): Closeable {
            observers += observer
            return Closeable { observers -= observer }
        }

        fun answerSubmit(value: WorktreeCreationSnapshot) {
            submitCallbacks.removeFirst()(success("worktree-creation:submit", value))
        }

        fun failSubmit(message: String) {
            submitCallbacks.removeFirst()(
                RemoteResponse(
                    RemoteRequestKey("machine", 7, "worktree-creation:submit"),
                    RemoteOutcome.Failure(message),
                ),
            )
        }

        fun answerGet(value: WorktreeCreationSnapshot?) {
            getCallbacks.removeFirst()(success("worktree-creation:get", value))
        }

        fun emit(value: WorktreeCreationSnapshot) {
            observers.toList().forEach { it(value) }
        }
    }
}

private class MemoryWorktreeStore : NewSessionWorktreeCreationStore {
    val saved = mutableListOf<WorktreeCreationRequest>()

    override fun save(
        creation: WorktreeCreationRequest,
        completion: (Result<Unit>) -> Unit,
    ) {
        saved.removeAll { it.creationId == creation.creationId }
        saved += creation
        completion(Result.success(Unit))
    }

    override fun load(connectionId: String, projectPath: String): WorktreeCreationRequest? =
        saved.singleOrNull { it.machineId == connectionId && it.projectPath == projectPath }

    override fun clear(creationId: String) {
        saved.removeAll { it.creationId == creationId }
    }
}

private class DelayedWorktreeStore : NewSessionWorktreeCreationStore {
    var pending: WorktreeCreationRequest? = null
    private var completion: ((Result<Unit>) -> Unit)? = null

    override fun save(
        creation: WorktreeCreationRequest,
        completion: (Result<Unit>) -> Unit,
    ) {
        pending = creation
        this.completion = completion
    }

    override fun load(connectionId: String, projectPath: String): WorktreeCreationRequest? = pending

    override fun clear(creationId: String) {
        if (pending?.creationId == creationId) pending = null
    }

    fun completeSave() {
        completion?.invoke(Result.success(Unit))
        completion = null
    }
}

private class FakeRemote : NewSessionRemote {
    val instances = mutableListOf<(RemoteResponse<List<ProviderInstance>>) -> Unit>()
    val settings = mutableListOf<Pair<String, (RemoteResponse<String?>) -> Unit>>()
    val creates = mutableListOf<Pair<CreateConversation, (RemoteResponse<CommandBody>) -> Unit>>()
    val starts = mutableListOf<Pair<StartSession, (RemoteResponse<StartedSession>) -> Unit>>()

    override fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) {
        instances += callback
    }

    override fun getSetting(key: String, callback: (RemoteResponse<String?>) -> Unit) {
        settings += key to callback
    }

    override fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        creates += input to callback
    }

    override fun startSession(
        input: StartSession,
        callback: (RemoteResponse<StartedSession>) -> Unit,
    ) {
        starts += input to callback
    }
}
