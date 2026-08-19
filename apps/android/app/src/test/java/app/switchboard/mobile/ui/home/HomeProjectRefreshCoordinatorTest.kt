package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.remote.BrowseRemote
import app.switchboard.mobile.data.remote.BrowseSnapshotSeed
import app.switchboard.mobile.data.remote.BrowseSnapshotStore
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.domain.remote.Workspace
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.ui.browse.BrowseLoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeProjectRefreshCoordinatorTest {
    @Test
    fun `cached projects stay visible while home refreshes and when refresh fails`() {
        val remote = FakeHomeBrowseRemote()
        val snapshots = FakeHomeSnapshotStore(listOf(project("cached")))
        val coordinator = coordinator(remote, snapshots)

        assertEquals("cached", coordinator.state.value.projects.items().single().project.name)

        coordinator.start()

        assertEquals("cached", coordinator.state.value.projects.items().single().project.name)
        assertEquals(1, remote.projects.size)
        assertTrue(remote.workspaces.isEmpty())

        remote.projects.removeFirst()(failure("offline"))

        val failed = coordinator.state.value.projects as BrowseLoadState.Failed
        assertEquals("offline", failed.message)
        assertEquals("cached", failed.cached.single().project.name)
        assertTrue(snapshots.savedProjects.isEmpty())
    }

    @Test
    fun `successful home refresh publishes and persists projects while mounted`() {
        val remote = FakeHomeBrowseRemote()
        val snapshots = FakeHomeSnapshotStore(listOf(project("cached")))
        val coordinator = coordinator(remote, snapshots)

        coordinator.start()
        remote.projects.removeFirst()(success(listOf(project("fresh"))))

        assertEquals("fresh", coordinator.state.value.projects.items().single().project.name)
        assertEquals(listOf("fresh"), snapshots.savedProjects.single().map(Project::name))
    }

    @Test
    fun `closing home coordinator fences a late response from the old lease`() {
        val remote = FakeHomeBrowseRemote()
        val snapshots = FakeHomeSnapshotStore(listOf(project("cached")))
        val coordinator = coordinator(remote, snapshots)

        coordinator.start()
        val late = remote.projects.removeFirst()
        coordinator.close()
        late(success(listOf(project("stale"))))

        assertEquals("cached", coordinator.state.value.projects.items().single().project.name)
        assertTrue(snapshots.savedProjects.isEmpty())
    }

    private fun coordinator(
        remote: FakeHomeBrowseRemote,
        snapshots: FakeHomeSnapshotStore,
    ) = HomeProjectRefreshCoordinator(
        connectionId = "machine",
        connectionLabel = "Studio Mac",
        offlineSnapshot = emptySnapshot(),
        remote = remote,
        expectedGeneration = 7,
        snapshotStore = snapshots,
    )

    private fun project(name: String) = Project(
        path = "/$name",
        name = name,
        sessions = listOf(
            SessionSummary(
                id = "$name-thread",
                source = "codex",
                title = name,
                startedAt = 1,
                messageCount = 1,
                filePath = "/$name.jsonl",
                raw = JsonObject(linkedMapOf()),
            ),
        ),
        workspaceId = null,
        raw = JsonObject(linkedMapOf()),
    )

    private fun success(projects: List<Project>) = RemoteResponse(
        RemoteRequestKey("machine", 7, "projects"),
        RemoteOutcome.Success(projects),
    )

    private fun failure(message: String): RemoteResponse<List<Project>> = RemoteResponse(
        RemoteRequestKey("machine", 7, "projects"),
        RemoteOutcome.Failure(message),
    )
}

private class FakeHomeBrowseRemote : BrowseRemote {
    val projects = ArrayDeque<(RemoteResponse<List<Project>>) -> Unit>()
    val workspaces = ArrayDeque<(RemoteResponse<List<Workspace>>) -> Unit>()

    override fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit) {
        projects += callback
    }

    override fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    ) = Unit

    override fun listWorkspaces(callback: (RemoteResponse<List<Workspace>>) -> Unit) {
        workspaces += callback
    }

    override fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = Unit

    override fun renameConversation(
        conversationId: String,
        title: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = Unit
}

private class FakeHomeSnapshotStore(initialProjects: List<Project>) : BrowseSnapshotStore {
    private val initial = BrowseSnapshotSeed(projects = initialProjects)
    val savedProjects = mutableListOf<List<Project>>()

    override fun load(connectionId: String): BrowseSnapshotSeed = initial

    override fun saveProjects(connectionId: String, projects: List<Project>) {
        savedProjects += projects
    }

    override fun saveWorkspaces(connectionId: String, workspaces: List<Workspace>) = Unit

    override fun saveConversations(
        connectionId: String,
        projectPath: String,
        conversations: List<Conversation>,
    ) = Unit
}

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

private fun <T> BrowseLoadState<T>.items(): List<T> = when (this) {
    is BrowseLoadState.Loading -> cached
    is BrowseLoadState.Ready -> items
    is BrowseLoadState.Failed -> cached
}
