package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.domain.remote.BrowseDecisions
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.Workspace

enum class BrowseThreadAttention {
    Unknown,
    None,
    Approval,
    Input,
}

data class BrowseThreadActivity(
    val status: String?,
    val unread: Int,
    val attention: BrowseThreadAttention = BrowseThreadAttention.Unknown,
)

data class BrowseProjectActivity(
    val status: String?,
    val unread: Int,
)

data class BrowseProjectSection(
    val key: String,
    val name: String,
    val workspace: Workspace?,
    val projects: List<Project>,
    val projectCount: Int,
    val collapsed: Boolean,
)

object BrowseParityDecisions {
    const val UNGROUPED_WORKSPACE_KEY = "ungrouped"

    fun showProjectSearch(projectCount: Int, query: String): Boolean =
        projectCount > 6 || query.isNotBlank()

    fun projectMatches(project: Project, query: String): Boolean {
        val needle = query.trim()
        return needle.isEmpty() ||
            project.name.contains(needle, ignoreCase = true) ||
            project.path.contains(needle, ignoreCase = true)
    }

    fun showConversationSearch(conversationCount: Int, query: String): Boolean =
        conversationCount > 8 || query.isNotBlank()

    fun conversationTitleMatches(title: String, query: String): Boolean {
        val needle = query.trim()
        return needle.isEmpty() || title.contains(needle, ignoreCase = true)
    }

    fun sections(
        projects: List<Project>,
        workspaces: List<Workspace>,
        collapsedWorkspaceIds: Set<String>,
        query: String,
    ): List<BrowseProjectSection> {
        val searching = query.isNotBlank()
        val filtered = projects.filter { projectMatches(it, query) }
        val groups = BrowseDecisions.groupProjects(filtered, workspaces)
            .filter { it.projects.isNotEmpty() }
        val canCollapse = groups.size > 1 && !searching
        return groups.map { group ->
            val key = group.workspace?.id ?: UNGROUPED_WORKSPACE_KEY
            val collapsed = canCollapse && key in collapsedWorkspaceIds
            BrowseProjectSection(
                key = key,
                name = group.workspace?.name ?: "Other projects",
                workspace = group.workspace,
                projects = if (collapsed) emptyList() else group.projects,
                projectCount = group.projects.size,
                collapsed = collapsed,
            )
        }
    }

    fun projectActivity(
        threadIds: List<String>,
        activity: Map<String, BrowseThreadActivity>,
    ): BrowseProjectActivity {
        val rows = threadIds.mapNotNull(activity::get)
        return BrowseProjectActivity(
            status = rows.maxByOrNull { statusPriority(it.status) }?.status,
            unread = rows.sumOf { it.unread.coerceAtLeast(0) },
        )
    }

    private fun statusPriority(status: String?): Int = when (status) {
        "error", "failed" -> 5
        "running", "streaming", "working" -> 4
        "starting", "connecting", "waiting", "queued" -> 3
        "idle", "completed" -> 2
        "offline", "disconnected" -> 1
        else -> 0
    }
}
