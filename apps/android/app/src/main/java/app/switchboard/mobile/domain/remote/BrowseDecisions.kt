package app.switchboard.mobile.domain.remote

data class WorkspaceGroup(
    val workspace: Workspace?,
    val projects: List<Project>,
)

object BrowseDecisions {
    fun groupProjects(
        projects: List<Project>,
        workspaces: List<Workspace>,
    ): List<WorkspaceGroup> {
        val known = workspaces.mapTo(mutableSetOf()) { it.id }
        val byWorkspace = linkedMapOf<String, MutableList<Project>>()
        val ungrouped = mutableListOf<Project>()
        projects.forEach { project ->
            val workspaceId = project.workspaceId
            if (workspaceId != null && workspaceId in known) {
                byWorkspace.getOrPut(workspaceId, ::mutableListOf) += project
            } else {
                ungrouped += project
            }
        }
        val groups = workspaces
            .sortedWith(compareBy<Workspace> { it.sortOrder }.thenBy { it.createdAt })
            .map { WorkspaceGroup(it, byWorkspace[it.id].orEmpty()) }
            .toMutableList()
        if (ungrouped.isNotEmpty()) groups += WorkspaceGroup(null, ungrouped)
        return groups
    }

    /** Stable newest-first ordering, matching JS Array.sort on the RN screen. */
    fun sortConversations(conversations: List<Conversation>): List<Conversation> =
        conversations.withIndex()
            .sortedWith(
                compareByDescending<IndexedValue<Conversation>> { it.value.updatedAt }
                    .thenBy { it.index },
            )
            .map { it.value }
}
