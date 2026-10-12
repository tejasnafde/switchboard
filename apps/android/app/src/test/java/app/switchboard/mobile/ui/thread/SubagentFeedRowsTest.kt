package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.SubagentStatus
import app.switchboard.mobile.domain.thread.SyntheticUserMessage
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubagentFeedRowsTest {
    private fun input(vararg fields: Pair<String, String>): JsonValue =
        JsonObject(linkedMapOf(*fields.map { (key, value) -> key to (JsonString(value) as JsonValue) }.toTypedArray()))

    private fun tool(
        id: String,
        name: String,
        parent: String? = null,
        output: String? = "ok",
        state: String = "done",
        isError: Boolean = false,
        input: JsonValue = input("command" to "ls $id"),
    ) = FeedItem.Tool("t-$id", id, name, input, output, state, parentToolCallId = parent, isError = isError)

    @Test
    fun twoParallelSubagentsEachKeepTheirOwnSteps() {
        val feed = listOf(
            FeedItem.User("u1", "go", 1),
            tool("A1", "Agent", output = null, state = "running", input = input("description" to "Scan docs", "model" to "haiku")),
            tool("A2", "Task", output = "Done.\nagentId: x (internal)", input = input("description" to "Read tests")),
            tool("X1", "Grep", parent = "A1"),
            tool("Y1", "Read", parent = "A2"),
            tool("X2", "Bash", parent = "A1", output = null, state = "running"),
            FeedItem.Text("m-sub", "sub", "Looking around", "assistant", parentToolCallId = "A1"),
            tool("C", "Read"),
        )

        val rows = ThreadPresenter.feedRows(feed)

        assertEquals(listOf("u1", "t-A1", "t-A2", "t-C"), rows.map { it.key })
        val first = rows[1] as ThreadRowPresentation.Subagent
        assertEquals("Scan docs", first.description)
        assertEquals("haiku", first.model)
        assertEquals(SubagentStatus.RUNNING, first.status)
        assertEquals("Step 3 · Looking around", first.statusText)
        assertEquals(listOf("t-X1", "t-X2", "m-sub"), first.items.map { it.key })
        val second = rows[2] as ThreadRowPresentation.Subagent
        assertEquals(SubagentStatus.DONE, second.status)
        assertEquals("Done · 1 step", second.statusText)
        assertEquals("Done.", second.result)
        assertEquals(listOf("t-Y1"), second.items.map { it.key })
    }

    @Test
    fun anOlderBackendKeepsTodaysRowsAndStillShowsTheAgentRow() {
        val notice = FeedItem.User(
            "task_1",
            SyntheticUserMessage.taskNotificationText("b1", "completed", "Background command \"make\" completed", null),
            2,
            fromTranscript = true,
        )
        val feed = listOf(
            tool("A", "Agent", output = "All good.", input = input("prompt" to "Review the diff\nand more")),
            tool("B", "Bash"),
            notice,
        )

        val rows = ThreadPresenter.feedRows(feed)

        assertEquals(listOf("t-A", "t-B", "task_1-s0"), rows.map { it.key })
        val agent = rows[0] as ThreadRowPresentation.Subagent
        assertEquals("Review the diff", agent.description)
        assertEquals("Done", agent.statusText)
        assertEquals(emptyList<SubagentItemRow>(), agent.items)
        assertEquals(ThreadPresenter.row(feed[1]), rows[1])
    }

    @Test
    fun aBackgroundAgentFinishesByItsNoticeAndTheNoticeLeavesTheTopLevel() {
        val completion = FeedItem.User(
            "task_2",
            SyntheticUserMessage.taskNotificationText("a1", "failed", "Agent \"Audit\" failed: API Error 529", null, "A"),
            50_000,
            fromTranscript = true,
        )
        val feed = listOf(
            tool("A", "Agent", output = "Async agent launched successfully.", input = input("description" to "Audit"))
                .copy(startedAt = 1_000),
            tool("B", "Bash", parent = "A", output = "Exit code 1", isError = true),
            completion,
        )

        val rows = ThreadPresenter.feedRows(feed)

        assertEquals(listOf("t-A"), rows.map { it.key })
        val agent = rows.single() as ThreadRowPresentation.Subagent
        assertEquals(SubagentStatus.FAILED, agent.status)
        assertEquals("Failed · API Error 529 · 1 step", agent.statusText)
        val step = agent.items.single() as SubagentItemRow.Step
        assertEquals(true, step.failed)
        assertEquals("t-B", step.row.key)
        assertNull(agent.result)
    }

    @Test
    fun aSubagentsNoticesFoldAndAFinishedCallWithoutOutputIsDone() {
        fun notice(id: String, status: String) = FeedItem.User(
            id,
            SyntheticUserMessage.taskNotificationText(id, status, "Background command \"$id\" $status", null, "B$id"),
            3,
            fromTranscript = true,
        )
        val feed = listOf(
            tool("A", "Agent", output = null, state = "done", input = input("description" to "d")),
            tool("B1", "Bash", parent = "A"),
            tool("B2", "Bash", parent = "A"),
            notice("1", "completed"),
            notice("2", "completed"),
        )

        val agent = ThreadPresenter.feedRows(feed).single() as ThreadRowPresentation.Subagent

        assertEquals(SubagentStatus.DONE, agent.status)
        assertEquals("Done · 4 steps", agent.statusText)
        val fold = agent.items.last() as SubagentItemRow.Fold
        assertEquals("2 background tasks completed", fold.label)
        assertEquals(true, fold.notices)
        assertEquals(listOf("1:0", "2:0"), fold.rows.map { it.key })
    }
}
