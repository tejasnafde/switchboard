package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import app.switchboard.mobile.ui.browse.BrowseThreadAttention

enum class HomeRecentStatus(val label: String) {
    Approval("Approval"),
    Input("Input"),
    Plan("Plan"),
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
    /** The backend has `chat_snooze_v1`; without it every snooze field is ignored. */
    val snooze: Boolean = false,
    /** Newer snooze states than the project list's, from broadcasts and this phone's answers. */
    val snoozes: Map<String, ChatSnooze.State> = emptyMap(),
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
    /** Its machine can snooze chats. */
    val snoozable: Boolean = false,
    val snooze: ChatSnooze.State = ChatSnooze.State.None,
) {
    /** Woke from a snooze and not opened since. */
    val woke: Boolean
        get() = snoozable && snooze.woke

    /** A chat that needs the user cannot be snoozed: the open card or the error would wake it at once. */
    val canSnooze: Boolean
        get() = snoozable && status != HomeRecentStatus.Approval && status != HomeRecentStatus.Input &&
            status != HomeRecentStatus.Plan && status != HomeRecentStatus.Failed
}

data class HomeRecentsPage(
    val items: List<HomeRecentRow>,
    val total: Int,
    /** The Snoozed shelf: the soonest wake first, PR-only last. */
    val snoozed: List<HomeRecentRow> = emptyList(),
) {
    val hasMore: Boolean
        get() = items.size < total
}

/**
 * The Snooze sheet of a Recents row (long press or a leftward swipe): the
 * presets resolved when it opened, each with its wake time, and "Until PR #n
 * changes" once the chat's links name an open PR. A refusal shows as [notice].
 */
data class HomeSnoozeSheet(
    val row: HomeRecentRow,
    val shownAt: Long,
    val pr: ChatSnooze.PrChoice? = null,
    val notice: String? = null,
    val busy: Boolean = false,
) {
    val items: List<HomeSnoozeItem>
        get() = HomePresenter.snoozeItems(shownAt, pr)
}

sealed interface HomeSnoozeChoice {
    data class Preset(val option: ChatSnooze.PresetOption) : HomeSnoozeChoice

    data class Pr(val pr: ChatSnooze.PrChoice) : HomeSnoozeChoice
}

/** One sheet row; [detail] is the wake time on the right, none for the PR item. */
data class HomeSnoozeItem(val key: String, val label: String, val detail: String, val choice: HomeSnoozeChoice)

/** What a tap sends on `app:snooze-conversation`. */
data class HomeSnoozeRequest(val until: Long?, val pr: String?, val preset: String)

object HomePresenter {
    fun snoozeItems(now: Long, pr: ChatSnooze.PrChoice?): List<HomeSnoozeItem> =
        ChatSnooze.resolvePresets(now).map { option ->
            HomeSnoozeItem(
                key = option.label,
                label = option.label,
                detail = ChatSnooze.wakeLabel(option.at, null, now),
                choice = HomeSnoozeChoice.Preset(option),
            )
        } + listOfNotNull(
            pr?.let { HomeSnoozeItem("pr", "Until PR #${it.number} changes", "", HomeSnoozeChoice.Pr(it)) },
        )

    /** A duration counts from the tap; a clock time keeps the instant the sheet showed, or is refused once passed. */
    fun snoozeRequest(choice: HomeSnoozeChoice, now: Long): HomeSnoozeRequest? = when (choice) {
        is HomeSnoozeChoice.Pr -> HomeSnoozeRequest(until = null, pr = choice.pr.key, preset = "pr")
        is HomeSnoozeChoice.Preset -> when (val picked = ChatSnooze.pickPreset(choice.option, now)) {
            is ChatSnooze.Pick.At -> HomeSnoozeRequest(picked.at, null, ChatSnooze.presetKindOf(choice.option.spec))
            ChatSnooze.Pick.Past -> null
        }
    }

    fun recents(
        machines: List<HomeMachineSnapshot>,
        limit: Int = 5,
    ): HomeRecentsPage {
        val seen = mutableSetOf<Pair<String, String>>()
        val all = machines.flatMap { machine ->
            machine.projects.flatMap { project ->
                project.sessions.mapNotNull { session ->
                    if (!seen.add(machine.connectionId to session.id)) return@mapNotNull null
                    val state = machine.threadStates[session.id]
                    val activity = machine.activity[session.id]
                    val unread = maxOf(state?.unread ?: 0, activity?.unread ?: 0)
                    val status = status(state, activity, unread)
                    val snooze = if (machine.snooze) {
                        ChatSnooze.newer(session.snooze, machine.snoozes[session.id])
                    } else {
                        ChatSnooze.State.None
                    }
                    // A settled chat leaves the desktop's "Done recently" only, so it still shows while it works or waits.
                    val idle = status == null || status == HomeRecentStatus.Done
                    if (!snooze.snoozed && !snooze.unsettled && idle && session.settledAt != null) return@mapNotNull null
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
                        status = status,
                        unread = unread,
                        snoozable = machine.snooze,
                        snooze = snooze,
                    )
                }
            }
        }
        // A snoozed chat waits in the shelf whatever its live status, until it wakes.
        val (shelved, rows) = all.partition { it.snooze.snoozed }
        val sorted = rows.sortedWith(
            compareByDescending<HomeRecentRow> { statusPriority(it.status) }
                .thenByDescending(HomeRecentRow::woke)
                .thenByDescending(HomeRecentRow::startedAt),
        )
        return HomeRecentsPage(
            items = sorted.take(limit.coerceAtLeast(0)),
            total = sorted.size,
            snoozed = shelved.sortedWith { a, b ->
                ChatSnooze.compareSnoozeWake(a.snooze.snoozedUntil, b.snooze.snoozedUntil)
            },
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
            BrowseThreadAttention.Plan -> return HomeRecentStatus.Plan
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
        // Only this run's activity (live events, or the backend's list-sessions
        // reply) says whether a turn is running. The thread snapshot's status is
        // whatever it was when the chat was last open, so a chat left mid-turn
        // kept reading Working after the turn ended, and again after a restart.
        return when (activity?.status?.lowercase()) {
            "running", "thinking", "streaming", "working" -> HomeRecentStatus.Working
            "error", "failed" -> HomeRecentStatus.Failed
            else -> if (unread > 0) HomeRecentStatus.Done else null
        }
    }

    private fun statusPriority(status: HomeRecentStatus?): Int = when (status) {
        HomeRecentStatus.Approval -> 5
        HomeRecentStatus.Input, HomeRecentStatus.Plan -> 4
        HomeRecentStatus.Working -> 3
        HomeRecentStatus.Failed -> 2
        HomeRecentStatus.Done -> 1
        null -> 0
    }
}
