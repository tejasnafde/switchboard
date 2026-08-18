package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.Workspace

data class BrowseSnapshotSeed(
    val projects: List<Project> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
    val conversationsByProject: Map<String, List<Conversation>> = emptyMap(),
)

interface BrowseSnapshotStore {
    fun load(connectionId: String): BrowseSnapshotSeed

    fun saveProjects(connectionId: String, projects: List<Project>)

    fun saveWorkspaces(connectionId: String, workspaces: List<Workspace>)

    fun saveConversations(
        connectionId: String,
        projectPath: String,
        conversations: List<Conversation>,
    )
}

object EmptyBrowseSnapshotStore : BrowseSnapshotStore {
    override fun load(connectionId: String) = BrowseSnapshotSeed()

    override fun saveProjects(connectionId: String, projects: List<Project>) = Unit

    override fun saveWorkspaces(connectionId: String, workspaces: List<Workspace>) = Unit

    override fun saveConversations(
        connectionId: String,
        projectPath: String,
        conversations: List<Conversation>,
    ) = Unit
}
