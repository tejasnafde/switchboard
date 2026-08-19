package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.thread.ThreadState
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
                        "working" to ThreadState(status = "running"),
                        "failed" to ThreadState(status = "error"),
                        "done" to ThreadState(status = "idle", unread = 1),
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

    private fun machine(
        id: String = "mac",
        label: String = "Studio Mac",
        projects: List<Project>,
        states: Map<String, ThreadState> = emptyMap(),
        activity: Map<String, BrowseThreadActivity> = emptyMap(),
    ) = HomeMachineSnapshot(id, label, projects, states, activity)

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
