package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.domain.remote.Workspace
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.ui.browse.BrowseLoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowseCoordinatorTest {
    @Test
    fun refreshPublishesProjectsAndPreservesThemWhenNextRefreshFails() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)

        coordinator.refreshProjects()
        remote.projects.removeAt(0).invoke(success("projects", listOf(project("one"))))

        assertEquals("one", coordinator.state.value.projects.items().single().project.name)

        coordinator.refreshProjects()
        assertEquals(1, coordinator.state.value.projects.items().size)
        remote.projects.removeAt(0).invoke(failure("projects", "offline"))

        val failed = coordinator.state.value.projects as BrowseLoadState.Failed
        assertEquals("offline", failed.message)
        assertEquals("one", failed.cached.single().project.name)
    }

    @Test
    fun olderProjectResponseCannotReplaceNewerRefresh() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)

        coordinator.refreshProjects()
        val first = remote.projects.removeAt(0)
        coordinator.refreshProjects()
        val second = remote.projects.removeAt(0)

        second(success("projects", listOf(project("new"))))
        first(success("projects", listOf(project("old"))))

        assertEquals("new", coordinator.state.value.projects.items().single().project.name)
    }

    @Test
    fun conversationRefreshesAreIndependentPerProjectAndRejectStaleResponses() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)

        coordinator.refreshConversations("/a")
        val oldA = remote.conversations.removeAt(0).second
        coordinator.refreshConversations("/b")
        val b = remote.conversations.removeAt(0).second
        coordinator.refreshConversations("/a")
        val newA = remote.conversations.removeAt(0).second

        b(success("conversations:/b", listOf(conversation("b"))))
        newA(success("conversations:/a", listOf(conversation("new-a"))))
        oldA(success("conversations:/a", listOf(conversation("old-a"))))

        assertEquals("new-a", coordinator.state.value.conversationsByProject.getValue("/a").items().single().conversation.id)
        assertEquals("b", coordinator.state.value.conversationsByProject.getValue("/b").items().single().conversation.id)
    }

    @Test
    fun mismatchedConnectionResponseIsIgnored() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)

        coordinator.refreshProjects()
        remote.projects.removeAt(0).invoke(
            RemoteResponse(
                RemoteRequestKey("other", 1, "projects"),
                RemoteOutcome.Success(listOf(project("wrong"))),
            ),
        )

        assertTrue(coordinator.state.value.projects is BrowseLoadState.Loading)
    }

    @Test
    fun responseFromAnOlderReadyLeaseGenerationIsIgnored() {
        val remote = FakeBrowseRemote()
        val coordinator = BrowseCoordinator(
            connectionId = "machine",
            connectionLabel = "Desktop",
            offlineSnapshot = emptySnapshot(),
            remote = remote,
            expectedGeneration = 7,
        )

        coordinator.refreshProjects()
        remote.projects.removeFirst().invoke(
            RemoteResponse(
                RemoteRequestKey("machine", 6, "projects"),
                RemoteOutcome.Success(listOf(project("stale"))),
            ),
        )

        assertTrue(coordinator.state.value.projects is BrowseLoadState.Loading)
    }

    @Test
    fun projectRefreshLoadsWorkspacesInParallelAndFencesTheirStaleResponses() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)

        coordinator.refreshProjects()
        val first = remote.workspaces.removeFirst()
        coordinator.refreshProjects()
        val second = remote.workspaces.removeFirst()

        second(success("workspaces", listOf(workspace("current"))))
        first(success("workspaces", listOf(workspace("stale"))))

        assertEquals("current", coordinator.state.value.workspaces.items().single().id)
    }

    @Test
    fun renameIsOptimisticEnsuresTheRowAndRollsBackOnDefiniteFailure() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)
        coordinator.refreshConversations("/a")
        remote.conversations.removeFirst().second(
            success("conversations:/a", listOf(conversation("thread-a").copy(projectPath = "/a"))),
        )

        coordinator.renameConversation("/a", "thread-a", "  Renamed  ")

        assertEquals(
            "Renamed",
            coordinator.state.value.conversationsByProject.getValue("/a").items().single().conversation.title,
        )
        assertEquals("thread-a", remote.creates.single().first.id)
        remote.creates.removeFirst().second(success("create", CommandBody(JsonNull)))
        assertEquals("Renamed", remote.renames.single().title)
        remote.renames.removeFirst().callback(failure("rename", "rename denied"))

        assertEquals(
            "thread-a",
            coordinator.state.value.conversationsByProject.getValue("/a").items().single().conversation.title,
        )
        assertEquals("rename denied", coordinator.state.value.renameErrors["thread-a"])
    }

    @Test
    fun successfulRenameKeepsFollowUpRefreshFailureBestEffort() {
        val remote = FakeBrowseRemote()
        val coordinator = coordinator(remote)
        coordinator.refreshConversations("/a")
        remote.conversations.removeFirst().second(
            success("conversations:/a", listOf(conversation("thread-a").copy(projectPath = "/a"))),
        )

        coordinator.renameConversation("/a", "thread-a", "Renamed")
        remote.creates.removeFirst().second(success("create", CommandBody(JsonNull)))
        remote.renames.removeFirst().callback(success("rename", CommandBody(JsonNull)))
        remote.conversations.removeFirst().second(failure("conversations:/a", "refresh offline"))

        assertTrue("thread-a" !in coordinator.state.value.renameErrors)
        assertEquals(
            "Renamed",
            coordinator.state.value.conversationsByProject.getValue("/a").items().single().conversation.title,
        )
    }

    private fun coordinator(remote: FakeBrowseRemote) = BrowseCoordinator(
        connectionId = "machine",
        connectionLabel = "Desktop",
        offlineSnapshot = emptySnapshot(),
        remote = remote,
    )

    private fun project(name: String) = Project(
        path = "/$name",
        name = name,
        sessions = listOf(
            SessionSummary("$name-thread", "codex", name, 1, 1, "/$name.jsonl", emptyJson()),
        ),
        workspaceId = null,
        raw = emptyJson(),
    )

    private fun conversation(id: String) = Conversation(
        id = id,
        projectPath = "/${id.substringAfterLast('-')}",
        agentType = "codex",
        sessionId = id,
        title = id,
        createdAt = 1,
        updatedAt = 2,
        worktreePath = null,
        worktreeBranch = null,
        raw = emptyJson(),
    )

    private fun workspace(id: String) = Workspace(
        id = id,
        name = id,
        color = null,
        sortOrder = 1,
        createdAt = 1,
        raw = emptyJson(),
    )

    private fun <T> success(operation: String, value: T) = RemoteResponse(
        RemoteRequestKey("machine", 1, operation),
        RemoteOutcome.Success(value),
    )

    private fun <T> failure(operation: String, message: String): RemoteResponse<T> = RemoteResponse(
        RemoteRequestKey("machine", 1, operation),
        RemoteOutcome.Failure(message),
    )

    private fun emptyJson() = JsonObject(linkedMapOf())

    private fun emptySnapshot() = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = emptyList(),
        feedRows = emptyList(),
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}

private class FakeBrowseRemote : BrowseRemote {
    data class Rename(
        val id: String,
        val title: String,
        val callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    val projects = ArrayDeque<(RemoteResponse<List<Project>>) -> Unit>()
    val conversations = ArrayDeque<Pair<String, (RemoteResponse<List<Conversation>>) -> Unit>>()
    val workspaces = ArrayDeque<(RemoteResponse<List<Workspace>>) -> Unit>()
    val creates = ArrayDeque<Pair<CreateConversation, (RemoteResponse<CommandBody>) -> Unit>>()
    val renames = ArrayDeque<Rename>()

    override fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit) {
        projects += callback
    }

    override fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    ) {
        conversations += projectPath to callback
    }

    override fun listWorkspaces(callback: (RemoteResponse<List<Workspace>>) -> Unit) {
        workspaces += callback
    }

    override fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        creates += input to callback
    }

    override fun renameConversation(
        conversationId: String,
        title: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        renames += Rename(conversationId, title, callback)
    }
}

private fun <T> BrowseLoadState<T>.items(): List<T> = when (this) {
    is BrowseLoadState.Loading -> cached
    is BrowseLoadState.Ready -> items
    is BrowseLoadState.Failed -> cached
}
