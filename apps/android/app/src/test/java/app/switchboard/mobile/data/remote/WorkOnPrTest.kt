package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.thread.PendingReviewPills
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.ModelOption
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.remote.StartedSession
import app.switchboard.mobile.domain.remote.WorktreeCreationCommand
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeExistingBranch
import app.switchboard.mobile.domain.reviews.ChecksRollup
import app.switchboard.mobile.domain.reviews.PrActionResult
import app.switchboard.mobile.domain.reviews.PrApprovals
import app.switchboard.mobile.domain.reviews.PrCheck
import app.switchboard.mobile.domain.reviews.PrDetail
import app.switchboard.mobile.domain.reviews.PrPerson
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.PrViewer
import app.switchboard.mobile.domain.reviews.WORK_ON_PR_CAPABILITY
import app.switchboard.mobile.domain.reviews.WORKTREE_CREATION_CAPABILITY
import app.switchboard.mobile.domain.reviews.WorkOnPr
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import java.io.Closeable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkOnPrTest {
    private val both = setOf(WORK_ON_PR_CAPABILITY, WORKTREE_CREATION_CAPABILITY)

    @Test
    fun withTheCapabilityAPrStartsInAWorktreeOnItsBranch() {
        val plan = requireNotNull(WorkOnPr.plan(pr(), both))
        assertEquals("/p/switchboard", plan.projectPath)
        assertEquals("switchboard", plan.projectName)
        assertEquals("fix/upload-retry", plan.existingBranch?.name)
        assertEquals("fix/upload-retry", plan.existingBranch?.fetch?.ref)
        assertEquals("In a worktree of switchboard on the PR's branch.", WorkOnPr.newChatSubtitle(plan))
    }

    @Test
    fun withoutTheCapabilityOrACheckoutItStartsInTheProject() {
        val older = requireNotNull(WorkOnPr.plan(pr(), setOf(WORKTREE_CREATION_CAPABILITY)))
        assertNull(older.existingBranch)
        assertEquals("In switchboard. The agent checks out the PR first.", WorkOnPr.newChatSubtitle(older))
        val bitbucketFork = pr().copy(ref = PrRef("bitbucket", "geoiq", "bb-sync", 598), headFromFork = true)
        assertNull(requireNotNull(WorkOnPr.plan(bitbucketFork, both)).existingBranch)
    }

    @Test
    fun noProjectMeansNoNewChat() {
        assertNull(WorkOnPr.plan(pr().copy(projectPaths = emptyList()), both))
        assertEquals("No project on this machine covers this repository", WorkOnPr.newChatSubtitle(null))
    }

    @Test
    fun theWorktreeRequestCarriesTheExistingBranchAndNoPrompt() {
        val intent = WorkOnPr.intent(detail(), requireNotNull(WorkOnPr.plan(pr(), both)))
        val port = CapturingWorktreePort()
        val coordinator = newSession(intent, port, worktreeAvailable = true)
        coordinator.submit()
        val request = (port.commands.single() as WorktreeCreationCommand.Ensure).request
        assertEquals(
            WorktreeExistingBranch(
                name = "fix/upload-retry",
                fetch = WorktreeExistingBranch.Fetch(
                    ref = "fix/upload-retry",
                    repo = WorktreeExistingBranch.Repo("github", "geoiq", "switchboard"),
                ),
            ),
            request.existingBranch,
        )
        assertNull(request.launchAgent.prompt)
        assertEquals("pr-1482", request.branchSeed)
        val wire = WorktreeCreationWire.encodeRequest(request)
        val existing = (wire.values.getValue("checkout") as JsonObject).values.getValue("existingBranch")
        assertEquals(
            """{"name":"fix/upload-retry","fetch":{"repo":{"host":"github","owner":"geoiq","name":"switchboard"},"ref":"fix/upload-retry"}}""",
            JsonCodec.encode(existing),
        )
        assertEquals(request, WorktreeCreationWire.decodeRequest(wire))
    }

    @Test
    fun withoutACheckoutTheChatStartsInTheParentCheckout() {
        val intent = WorkOnPr.intent(detail(), requireNotNull(WorkOnPr.plan(pr(), setOf(WORKTREE_CREATION_CAPABILITY))))
        val remote = CapturingNewSessionRemote()
        val port = CapturingWorktreePort()
        val coordinator = newSession(intent, port, worktreeAvailable = true, remote = remote)
        coordinator.selectWorkspace(NewSessionWorkspace.Worktree("HEAD", app.switchboard.mobile.domain.remote.WorktreeSetupPolicy.Skip))
        coordinator.submit()
        assertTrue(port.commands.isEmpty())
        assertEquals("/p/switchboard", remote.creates.single().projectPath)
    }

    @Test
    fun afterTheChatStartsThePrIsLinkedAndThePillAndDraftWait() {
        val intent = WorkOnPr.intent(detail(), requireNotNull(WorkOnPr.plan(pr(), both)))
        val remote = RecordingReviewsRemote()
        val pills = PendingReviewPills()
        val drafts = mutableListOf<ComposerDraft>()
        val starter = WorkOnPrStarter("machine", remote, pills, drafts::add)
        val inWorktree = starter.onStarted(NewSessionStarted("t1", "switchboard", "/p/switchboard", worktreePath = "/wt"), intent)
        assertTrue(inWorktree.content.contains("worktree on the pull request's branch"))
        assertEquals(inWorktree, pills.get(ComposerDraftKey("machine", "t1")))
        assertEquals(WorkOnPr.DRAFT, drafts.single().text)
        assertEquals("t1" to PrRef("github", "geoiq", "switchboard", 1482), remote.links.single().first)
        remote.links.single().second(RemoteResponse(RemoteRequestKey("machine", 1, "link"), RemoteOutcome.Success(PrActionResult(false, "no"))))

        // A worktree that fell back to the project: the pill asks for a checkout instead.
        val fellBack = starter.onStarted(NewSessionStarted("t2", "switchboard", "/p/switchboard"), intent)
        assertTrue(fellBack.content.contains("run `gh pr checkout 1482`"))
    }

    private fun newSession(
        intent: app.switchboard.mobile.domain.reviews.WorkOnPrIntent,
        port: CapturingWorktreePort,
        worktreeAvailable: Boolean,
        remote: CapturingNewSessionRemote = CapturingNewSessionRemote(),
    ) = NewSessionCoordinator(
        connectionId = "machine",
        generation = 1,
        projectPath = "/p/switchboard",
        projectName = "switchboard",
        remote = remote,
        enqueue = NewSessionEnqueue { error("a Work on PR chat has no first message") },
        ids = NewSessionIdSource { "thread-1" },
        clock = NewSessionClock { 10 },
        onStarted = {},
        worktrees = port,
        worktreeStore = ImmediateWorktreeStore(),
        creationIds = WorktreeCreationIdSource { "creation-1" },
        worktreeAvailable = worktreeAvailable,
        workOnPr = intent,
    )

    private fun pr() = PrSummary(
        ref = PrRef("github", "geoiq", "switchboard", 1482),
        title = "Retry uploads",
        url = "https://github.com/geoiq/switchboard/pull/1482",
        author = PrPerson("tejas", "tejas", null),
        state = "open",
        draft = false,
        sourceBranch = "fix/upload-retry",
        targetBranch = "main",
        headFromFork = false,
        createdAt = 0,
        updatedAt = 0,
        mergedAt = null,
        additions = null,
        deletions = null,
        changedFiles = null,
        unresolvedConversations = 0,
        mergeConflicts = false,
        conflictedFiles = emptyList(),
        checks = ChecksRollup("failure", 1, 0, 1, 0),
        reviewers = emptyList(),
        approvals = PrApprovals(0, null),
        viewer = PrViewer(isAuthor = true, isRequestedReviewer = false, hasReviewed = false, hasCommented = false),
        projectPaths = listOf("/p/switchboard"),
    )

    private fun detail() = PrDetail(pr(), "", listOf(PrCheck("lint", "lint", "failure", null, null, 1_000)))
}

private class CapturingWorktreePort : NewSessionWorktreeCreationPort {
    val commands = mutableListOf<WorktreeCreationCommand>()

    override fun submit(command: WorktreeCreationCommand, callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit) {
        commands += command
    }

    override fun get(creationId: String, callback: (RemoteResponse<WorktreeCreationSnapshot?>) -> Unit) = Unit

    override fun observe(observer: (WorktreeCreationSnapshot) -> Unit): Closeable = Closeable {}
}

private class ImmediateWorktreeStore : NewSessionWorktreeCreationStore {
    override fun save(creation: WorktreeCreationRequest, completion: (Result<Unit>) -> Unit) = completion(Result.success(Unit))
    override fun load(connectionId: String, projectPath: String): WorktreeCreationRequest? = null
    override fun clear(creationId: String) = Unit
}

private class CapturingNewSessionRemote : NewSessionRemote {
    val creates = mutableListOf<CreateConversation>()

    override fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) = Unit
    override fun getSetting(key: String, callback: (RemoteResponse<String?>) -> Unit) = Unit
    override fun createConversation(input: CreateConversation, callback: (RemoteResponse<CommandBody>) -> Unit) {
        creates += input
    }
    override fun startSession(input: StartSession, callback: (RemoteResponse<StartedSession>) -> Unit) = Unit
    override fun listCatalog(agentType: String, instanceId: String?, callback: (RemoteResponse<List<ModelOption>?>) -> Unit) = Unit
}
