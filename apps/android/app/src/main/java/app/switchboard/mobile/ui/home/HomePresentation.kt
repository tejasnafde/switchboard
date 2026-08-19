package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import app.switchboard.mobile.ui.browse.BrowseThreadAttention

enum class HomeRecentStatus(val label: String) {
    Approval("Approval"),
    Input("Input"),
    Working("Working"),
    Failed("Failed"),
    Done("Done"),
}

data class HomeMachineSnapshot(
    val connectionId: String,
    val connectionLabel: String,
    val projects: List<Project>,
    val threadStates: Map<String, ThreadState> = emptyMap(),
    val activity: Map<String, BrowseThreadActivity> = emptyMap(),
)

data class HomeRecentRow(
    val connectionId: String,
    val connectionLabel: String,
    val threadId: String,
    val title: String,
    val projectPath: String,
    val projectName: String,
    val provider: String,
    val worktreePath: String?,
    val worktreeBranch: String?,
    val startedAt: Long,
    val status: HomeRecentStatus?,
    val unread: Int,
)

data class HomeRecentsPage(
    val items: List<HomeRecentRow>,
    val total: Int,
) {
    val hasMore: Boolean
        get() = items.size < total
}

object HomePresenter {
    fun recents(
        machines: List<HomeMachineSnapshot>,
        limit: Int = 5,
    ): HomeRecentsPage {
        val seen = mutableSetOf<Pair<String, String>>()
        val rows = machines.flatMap { machine ->
            machine.projects.flatMap { project ->
                project.sessions.mapNotNull { session ->
                    if (!seen.add(machine.connectionId to session.id)) return@mapNotNull null
                    val state = machine.threadStates[session.id]
                    val activity = machine.activity[session.id]
                    val unread = maxOf(state?.unread ?: 0, activity?.unread ?: 0)
                    HomeRecentRow(
                        connectionId = machine.connectionId,
                        connectionLabel = machine.connectionLabel,
                        threadId = session.id,
                        title = session.title.ifBlank { "Untitled chat" },
                        projectPath = project.path,
                        projectName = project.name,
                        provider = session.agentType?.takeIf(String::isNotBlank)
                            ?: session.source.ifBlank { "codex" },
                        worktreePath = session.worktreePath,
                        worktreeBranch = session.worktreeBranch,
                        startedAt = session.startedAt,
                        status = status(state, activity, unread),
                        unread = unread,
                    )
                }
            }
        }.sortedWith(
            compareByDescending<HomeRecentRow> { statusPriority(it.status) }
                .thenByDescending(HomeRecentRow::startedAt),
        )
        return HomeRecentsPage(
            items = rows.take(limit.coerceAtLeast(0)),
            total = rows.size,
        )
    }

    private fun status(
        state: ThreadState?,
        activity: BrowseThreadActivity?,
        unread: Int,
    ): HomeRecentStatus? {
        when (activity?.attention) {
            BrowseThreadAttention.Approval -> return HomeRecentStatus.Approval
            BrowseThreadAttention.Input -> return HomeRecentStatus.Input
            BrowseThreadAttention.None -> Unit
            BrowseThreadAttention.Unknown, null -> {
                if (state?.feed?.any { it is FeedItem.Approval && it.state == "pending" } == true) {
                    return HomeRecentStatus.Approval
                }
                if (state?.feed?.any { it is FeedItem.Question && it.answers == null } == true) {
                    return HomeRecentStatus.Input
                }
            }
        }
        return when ((state?.status ?: activity?.status)?.lowercase()) {
            "running", "thinking", "streaming", "working" -> HomeRecentStatus.Working
            "error", "failed" -> HomeRecentStatus.Failed
            else -> if (unread > 0) HomeRecentStatus.Done else null
        }
    }

    private fun statusPriority(status: HomeRecentStatus?): Int = when (status) {
        HomeRecentStatus.Approval -> 5
        HomeRecentStatus.Input -> 4
        HomeRecentStatus.Working -> 3
        HomeRecentStatus.Failed -> 2
        HomeRecentStatus.Done -> 1
        null -> 0
    }
}
