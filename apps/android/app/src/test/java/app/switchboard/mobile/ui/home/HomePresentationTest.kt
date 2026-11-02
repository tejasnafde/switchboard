package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import app.switchboard.mobile.ui.browse.BrowseThreadAttention
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomePresentationTest {
    @Test
    fun `attention states outrank recency and preserve direct thread route metadata`() {
        val rows = HomePresenter.recents(
            machines = listOf(
                machine(
                    id = "mac",
                    projects = listOf(
                        project(
                            "/repo",
                            summary("done", startedAt = 500, agentType = "codex"),
                            summary(
                                "approval",
                                startedAt = 100,
                                agentType = "claude",
                                worktreePath = "/repo/.switchboard/worktrees/review",
                            ),
                            summary("input", startedAt = 200),
                            summary("working", startedAt = 300),
                            summary("failed", startedAt = 400),
                        ),
                    ),
                    states = mapOf(
                        "approval" to ThreadState(
                            status = "idle",
                            feed = listOf(approval("pending")),
                        ),
                        "input" to ThreadState(
                            status = "idle",
                            feed = listOf(question(answers = null)),
                        ),
                        "done" to ThreadState(status = "idle", unread = 1),
                    ),
                    activity = mapOf(
                        "working" to BrowseThreadActivity(status = "running", unread = 0),
                        "failed" to BrowseThreadActivity(status = "error", unread = 0),
                    ),
                ),
            ),
            limit = 5,
        )

        assertEquals(
            listOf(
                HomeRecentStatus.Approval,
                HomeRecentStatus.Input,
                HomeRecentStatus.Working,
                HomeRecentStatus.Failed,
                HomeRecentStatus.Done,
            ),
            rows.items.map(HomeRecentRow::status),
        )
        assertEquals("claude", rows.items.first().provider)
        assertEquals("/repo/.switchboard/worktrees/review", rows.items.first().worktreePath)
        assertEquals("/repo", rows.items.first().projectPath)
        assertEquals("Studio Mac", rows.items.first().connectionLabel)
    }

    @Test
    fun `neutral recents follow started time and cached activity can supply live status`() {
        val result = HomePresenter.recents(
            machines = listOf(
                machine(
                    id = "mac",
                    projects = listOf(
                        project(
                            "/repo",
                            summary("older", startedAt = 10),
                            summary("newer", startedAt = 30),
                            summary("cached-working", startedAt = 1),
                        ),
                    ),
                    activity = mapOf(
                        "cached-working" to BrowseThreadActivity(status = "thinking", unread = 0),
                    ),
                ),
            ),
            limit = 5,
        )

        assertEquals(listOf("cached-working", "newer", "older"), result.items.map(HomeRecentRow::threadId))
        assertEquals(HomeRecentStatus.Working, result.items.first().status)
        assertNull(result.items[1].status)
    }

    @Test
    fun `projection deduplicates within a machine but keeps matching ids on another machine`() {
        val duplicate = summary("thread", startedAt = 20)
        val result = HomePresenter.recents(
            machines = listOf(
                machine(
                    id = "mac-a",
                    label = "Mac A",
                    projects = listOf(project("/a", duplicate), project("/duplicate", duplicate)),
                ),
                machine(
                    id = "mac-b",
                    label = "Mac B",
                    projects = listOf(project("/b", duplicate)),
                ),
            ),
            limit = 5,
        )

        assertEquals(2, result.total)
        assertEquals(setOf("mac-a", "mac-b"), result.items.map(HomeRecentRow::connectionId).toSet())
        assertEquals("/a", result.items.first { it.connectionId == "mac-a" }.projectPath)
    }

    @Test
    fun `projection exposes a bounded page and whether more rows remain`() {
        val machines = listOf(
            machine(
                    projects = listOf(
                        project("/repo", *(1L..8L).map { summary("thread-$it", it) }.toTypedArray()),
                    ),
                )
        )
        val result = HomePresenter.recents(
            machines = machines,
            limit = 5,
        )

        assertEquals(5, result.items.size)
        assertEquals(8, result.total)
        assertTrue(result.hasMore)
        assertEquals("thread-8", result.items.first().threadId)
        assertEquals("thread-4", result.items.last().threadId)

        val expanded = HomePresenter.recents(machines, limit = 10)
        assertEquals(8, expanded.items.size)
        assertFalse(expanded.hasMore)
    }

    @Test
    fun `resolved prompts do not keep attention priority`() {
        val result = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(project("/repo", summary("resolved", 1))),
                    states = mapOf(
                        "resolved" to ThreadState(
                            status = "idle",
                            feed = listOf(approval("approve"), question(listOf(listOf("Yes")))),
                        ),
                    ),
                ),
            ),
            limit = 5,
        )

        assertNull(result.items.single().status)
    }

    @Test
    fun `live activity supplies actionable attention without loading thread state`() {
        val result = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("approval", 1),
                            summary("input", 2),
                        ),
                    ),
                    activity = mapOf(
                        "approval" to BrowseThreadActivity(
                            status = "idle",
                            unread = 0,
                            attention = BrowseThreadAttention.Approval,
                        ),
                        "input" to BrowseThreadActivity(
                            status = "idle",
                            unread = 0,
                            attention = BrowseThreadAttention.Input,
                        ),
                    ),
                ),
            ),
        )

        assertEquals(
            listOf(HomeRecentStatus.Approval, HomeRecentStatus.Input),
            result.items.map(HomeRecentRow::status),
        )
    }

    @Test
    fun `resolved live attention overrides a stale cached pending prompt`() {
        val result = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(project("/repo", summary("resolved", 1))),
                    states = mapOf(
                        "resolved" to ThreadState(
                            status = "idle",
                            feed = listOf(approval("pending")),
                        ),
                    ),
                    activity = mapOf(
                        "resolved" to BrowseThreadActivity(
                            status = "idle",
                            unread = 0,
                            attention = BrowseThreadAttention.None,
                        ),
                    ),
                ),
            ),
        )

        assertNull(result.items.single().status)
    }

    @Test
    fun `a cached running status shows nothing until live activity says so`() {
        fun recent(activity: BrowseThreadActivity?) = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(project("/repo", summary("chat", 1))),
                    // The snapshot from when the chat was last open, mid-turn.
                    states = mapOf("chat" to ThreadState(status = "running")),
                    activity = listOfNotNull(activity?.let { "chat" to it }).toMap(),
                ),
            ),
        ).items.single().status

        // Cold start: no live status yet.
        assertNull(recent(null))
        // An idle live session (list-sessions), or a turn.completed that arrived with the chat closed.
        assertNull(recent(BrowseThreadActivity(status = "idle", unread = 0)))
        // No live session at all: missing from the list-sessions reply.
        assertNull(recent(BrowseThreadActivity(status = null, unread = 0)))
        assertEquals(HomeRecentStatus.Working, recent(BrowseThreadActivity(status = "running", unread = 0)))
    }

    @Test
    fun `a chat settled on the desktop leaves Recents while idle, even after an edit moved its time`() {
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("settled", startedAt = 100, settledAt = 200),
                            summary("renamed", startedAt = 300, settledAt = 200),
                            summary("working", startedAt = 50, settledAt = 200),
                            summary("plain", startedAt = 40),
                        ),
                    ),
                    activity = mapOf("working" to BrowseThreadActivity(status = "running", unread = 0)),
                ),
            ),
            limit = 10,
        )

        assertEquals(listOf("working", "plain"), page.items.map(HomeRecentRow::threadId))
        assertEquals(2, page.total)
    }

    @Test
    fun `snoozed chats leave Recents for the shelf, soonest wake first and PR-only last`() {
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("plain", startedAt = 100),
                            summary("pr-only", startedAt = 500, snooze = snoozed(until = null, pr = "github:acme/app#1")),
                            summary("tomorrow", startedAt = 400, snooze = snoozed(until = 2_000)),
                            summary("tonight", startedAt = 300, snooze = snoozed(until = 1_000)),
                            summary("working", startedAt = 200, snooze = snoozed(until = 3_000), settledAt = 50),
                        ),
                    ),
                    activity = mapOf("working" to BrowseThreadActivity(status = "running", unread = 0)),
                    snooze = true,
                ),
            ),
            limit = 10,
        )

        assertEquals(listOf("plain"), page.items.map(HomeRecentRow::threadId))
        assertEquals(1, page.total)
        assertEquals(listOf("tonight", "tomorrow", "working", "pr-only"), page.snoozed.map(HomeRecentRow::threadId))
        assertEquals(HomeRecentStatus.Working, page.snoozed.single { it.threadId == "working" }.status)
    }

    @Test
    fun `a settled chat snoozed and woken since the list was read shows in Recents`() {
        val woke = ChatSnooze.State(snoozeRev = 3, wokeAt = 900, wokeReason = "time")
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("unsettled", startedAt = 100, settledAt = 50),
                            summary("settled", startedAt = 200, settledAt = 50),
                        ),
                    ),
                    snooze = true,
                    snoozes = mapOf("unsettled" to woke.copy(unsettled = true), "settled" to woke),
                ),
            ),
            limit = 10,
        )

        assertEquals(listOf("unsettled"), page.items.map(HomeRecentRow::threadId))
    }

    @Test
    fun `a woken chat sorts first in its status group and shows Woke`() {
        val woke = ChatSnooze.State(snoozeRev = 2, wokeAt = 900, wokeReason = "time")
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("newer", startedAt = 500),
                            summary("woken", startedAt = 100, snooze = woke),
                            summary("working", startedAt = 50),
                            summary("woken-working", startedAt = 40, snooze = woke),
                        ),
                    ),
                    activity = mapOf(
                        "working" to BrowseThreadActivity(status = "running", unread = 0),
                        "woken-working" to BrowseThreadActivity(status = "running", unread = 0),
                    ),
                    snooze = true,
                ),
            ),
            limit = 10,
        )

        assertEquals(listOf("woken-working", "working", "woken", "newer"), page.items.map(HomeRecentRow::threadId))
        assertEquals(listOf(true, false, true, false), page.items.map(HomeRecentRow::woke))
    }

    @Test
    fun `a newer state from a broadcast or an answer wins over the project list`() {
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("snoozed-here", startedAt = 100),
                            summary("changed-elsewhere", startedAt = 200, snooze = snoozed(until = 1_000, rev = 4)),
                        ),
                    ),
                    snooze = true,
                    snoozes = mapOf(
                        "snoozed-here" to snoozed(until = 1_000, rev = 1),
                        "changed-elsewhere" to snoozed(until = 5_000, rev = 3),
                    ),
                ),
            ),
            limit = 10,
        )

        assertEquals(listOf("snoozed-here", "changed-elsewhere"), page.snoozed.map(HomeRecentRow::threadId))
        assertEquals(1_000L, page.snoozed.last().snooze.snoozedUntil)
    }

    @Test
    fun `a machine without chat_snooze_v1 ignores every snooze field`() {
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("snoozed", startedAt = 200, snooze = snoozed(until = 1_000)),
                            summary("woken", startedAt = 100, snooze = ChatSnooze.State(snoozeRev = 2, wokeAt = 900)),
                        ),
                    ),
                    snoozes = mapOf("woken" to snoozed(until = 1_000, rev = 9)),
                ),
            ),
            limit = 10,
        )

        assertEquals(listOf("snoozed", "woken"), page.items.map(HomeRecentRow::threadId))
        assertTrue(page.snoozed.isEmpty())
        assertTrue(page.items.none { it.woke || it.canSnooze })
    }

    @Test
    fun `a chat that needs the user cannot be snoozed`() {
        val page = HomePresenter.recents(
            machines = listOf(
                machine(
                    projects = listOf(
                        project(
                            "/repo",
                            summary("approval", startedAt = 500),
                            summary("input", startedAt = 400),
                            summary("plan", startedAt = 350),
                            summary("failed", startedAt = 300),
                            summary("working", startedAt = 200),
                            summary("idle", startedAt = 100),
                        ),
                    ),
                    states = mapOf(
                        "approval" to ThreadState(status = "idle", feed = listOf(approval("pending"))),
                        "input" to ThreadState(status = "idle", feed = listOf(question(answers = null))),
                    ),
                    activity = mapOf(
                        "plan" to BrowseThreadActivity(status = "idle", unread = 0, attention = BrowseThreadAttention.Plan),
                        "failed" to BrowseThreadActivity(status = "error", unread = 0),
                        "working" to BrowseThreadActivity(status = "running", unread = 0),
                    ),
                    snooze = true,
                ),
            ),
            limit = 10,
        )

        assertEquals(
            mapOf(
                "approval" to false,
                "input" to false,
                "plan" to false,
                "working" to true,
                "failed" to false,
                "idle" to true,
            ),
            page.items.associate { it.threadId to it.canSnooze },
        )
    }

    private fun snoozed(until: Long?, pr: String? = null, rev: Long = 1) =
        ChatSnooze.State(snoozedUntil = until, snoozedAt = 10, snoozePr = pr, snoozeRev = rev)

    private fun machine(
        id: String = "mac",
        label: String = "Studio Mac",
        projects: List<Project>,
        states: Map<String, ThreadState> = emptyMap(),
        activity: Map<String, BrowseThreadActivity> = emptyMap(),
        snooze: Boolean = false,
        snoozes: Map<String, ChatSnooze.State> = emptyMap(),
    ) = HomeMachineSnapshot(id, label, projects, states, activity, snooze, snoozes)

    private fun project(path: String, vararg sessions: SessionSummary) = Project(
        path = path,
        name = path.substringAfterLast('/').ifBlank { "Project" },
        sessions = sessions.toList(),
        workspaceId = null,
        raw = JsonObject(linkedMapOf()),
    )

    private fun summary(
        id: String,
        startedAt: Long,
        agentType: String? = null,
        worktreePath: String? = null,
        settledAt: Long? = null,
        snooze: ChatSnooze.State = ChatSnooze.State.None,
    ) = SessionSummary(
        id = id,
        source = "codex",
        title = "Title $id",
        startedAt = startedAt,
        messageCount = 1,
        filePath = "/tmp/$id.jsonl",
        raw = JsonObject(linkedMapOf()),
        agentType = agentType,
        worktreePath = worktreePath,
        worktreeBranch = worktreePath?.let { "sb/review" },
        settledAt = settledAt,
        snooze = snooze,
    )

    private fun approval(state: String) = FeedItem.Approval(
        id = "approval",
        requestId = "request",
        toolName = "Bash",
        detail = "Run tests",
        requestType = "command",
        state = state,
    )

    private fun question(answers: List<List<String>>?) = FeedItem.Question(
        id = "question",
        requestId = "question",
        questions = emptyList(),
        answers = answers,
    )
}
