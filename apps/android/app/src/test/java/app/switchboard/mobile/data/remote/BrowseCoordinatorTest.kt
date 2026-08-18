package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.SessionSummary
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
    val projects = ArrayDeque<(RemoteResponse<List<Project>>) -> Unit>()
    val conversations = ArrayDeque<Pair<String, (RemoteResponse<List<Conversation>>) -> Unit>>()

    override fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit) {
        projects += callback
    }

    override fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    ) {
        conversations += projectPath to callback
    }
}

private fun <T> BrowseLoadState<T>.items(): List<T> = when (this) {
    is BrowseLoadState.Loading -> cached
    is BrowseLoadState.Ready -> items
    is BrowseLoadState.Failed -> cached
}
