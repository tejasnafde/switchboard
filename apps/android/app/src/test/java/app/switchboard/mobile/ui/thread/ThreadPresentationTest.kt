package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.QuestionOption
import app.switchboard.mobile.domain.thread.ThreadQuestion
import app.switchboard.mobile.domain.thread.TodoEntry
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadPresentationTest {
    @Test
    fun everyFeedVariantHasAnHonestStablePresentationRow() {
        val feed = everyFeedVariant()

        val content = ThreadPresenter.present(ThreadLoadState.Ready(ThreadState(feed = feed)))
            as ThreadPresentation.Content

        assertEquals(feed.map(FeedItem::id), content.rows.map(ThreadRowPresentation::key))
        assertEquals(
            listOf(
                ThreadRowKind.USER,
                ThreadRowKind.ASSISTANT,
                ThreadRowKind.REASONING,
                ThreadRowKind.PLAN_STREAM,
                ThreadRowKind.TOOL,
                ThreadRowKind.DENIAL,
                ThreadRowKind.APPROVAL,
                ThreadRowKind.RETRY,
                ThreadRowKind.ERROR,
                ThreadRowKind.PLAN,
                ThreadRowKind.QUESTION,
                ThreadRowKind.FILE_EDIT,
                ThreadRowKind.DRIFT,
                ThreadRowKind.SPEND_BLOCKED,
                ThreadRowKind.PEER,
                ThreadRowKind.TODO,
                ThreadRowKind.RAW_NOTICE,
            ),
            content.rows.map(ThreadRowPresentation::kind),
        )

        val tool = content.rows.filterIsInstance<ThreadRowPresentation.Tool>().single()
        assertEquals("{\"path\":\"README.md\"}", tool.input)
        assertEquals("done", tool.output)
        val file = content.rows.filterIsInstance<ThreadRowPresentation.FileEdit>().single()
        assertEquals(1, file.addedLines)
        assertEquals(1, file.removedLines)
        assertEquals("src/Main.kt", file.relPath)
        val raw = content.rows.filterIsInstance<ThreadRowPresentation.RawNotice>().single()
        assertEquals("provider.future", raw.eventType)
        assertEquals("{\"future\":\"kept\"}", raw.raw)
    }

    @Test
    fun rawNoticeDiagnosticsAreBoundedBeforePresentation() {
        val row = ThreadPresenter.row(
            FeedItem.RawNotice(
                id = "large-raw",
                eventType = "provider.future",
                text = "Unsupported provider event",
                raw = JsonObject(linkedMapOf("payload" to JsonString("x".repeat(20_000)))),
            ),
        ) as ThreadRowPresentation.RawNotice

        assertTrue(row.raw.length <= 8_000)
        assertTrue(row.raw.endsWith("… <diagnostic truncated>"))
    }

    @Test
    fun `history window is presented as a product notice without diagnostics`() {
        val row = ThreadPresenter.row(
            FeedItem.RawNotice(
                id = "history-window",
                eventType = "history.window",
                text = "Showing the last 250 of 1,366 messages",
                raw = JsonObject(linkedMapOf("shown" to JsonString("250"))),
            ),
        ) as ThreadRowPresentation.Notice

        assertEquals("history-window", row.key)
        assertEquals("Earlier messages are not shown", row.title)
        assertEquals("Showing the last 250 of 1,366 messages", row.body)
    }

    @Test
    fun metadataIncludesStatusContextCostDurationAndProviderWithoutGuessing() {
        val state = ThreadState(
            feed = listOf(FeedItem.User("u", "hello", 1)),
            status = "running",
            runtimeMode = "accept-edits",
            provider = "codex",
            instanceName = "Work",
            usedTokens = 1_500,
            maxTokens = 2_000,
            costUsd = 0.42,
            resolvedModel = "gpt-5.6-luna",
            lastTurnDurationMs = 1_250,
            unread = 3,
        )

        val content = ThreadPresenter.present(ThreadLoadState.Ready(state)) as ThreadPresentation.Content
        val metadata = content.metadata

        assertEquals("running", metadata.status)
        assertEquals("accept-edits", metadata.runtimeMode)
        assertEquals("codex", metadata.provider)
        assertEquals("Work", metadata.instanceName)
        assertEquals("gpt-5.6-luna", metadata.model)
        assertEquals("1500 / 2000 tokens", metadata.contextLabel)
        assertEquals(0.75f, metadata.contextFraction)
        assertEquals("$0.42", metadata.costLabel)
        assertEquals("1.3s", metadata.durationLabel)
        assertEquals(3, metadata.unread)
    }

    @Test
    fun invalidContextMaximumNeverProducesAMisleadingMeter() {
        val metadata = ThreadPresenter.metadata(
            ThreadState(usedTokens = 100, maxTokens = 0),
        )

        assertEquals("100 tokens", metadata.contextLabel)
        assertNull(metadata.contextFraction)
    }

    @Test
    fun cachedFeedRemainsVisibleDuringReseedAndFailure() {
        val cached = ThreadState(
            feed = listOf(FeedItem.User("cached", "saved message", 1)),
            awaitingReseed = true,
        )
        val loading = ThreadPresenter.present(ThreadLoadState.Loading(cached))
            as ThreadPresentation.Content
        val failed = ThreadPresenter.present(ThreadLoadState.Failed("Backend unavailable", cached))
            as ThreadPresentation.Content

        assertEquals(listOf("cached"), loading.rows.map { it.key })
        assertEquals(ThreadContentStatusKind.CACHED, loading.contentStatus.kind)
        assertTrue(loading.contentStatus.showProgress)
        assertEquals(listOf("cached"), failed.rows.map { it.key })
        assertEquals(ThreadContentStatusKind.ERROR, failed.contentStatus.kind)
        assertEquals("Backend unavailable", failed.contentStatus.detail)
        assertTrue(failed.contentStatus.canRetry)
    }

    @Test
    fun fullPageStatesOnlyReplaceAThreadWhenNoFeedExists() {
        assertEquals(ThreadPresentation.Loading, ThreadPresenter.present(ThreadLoadState.Loading()))
        assertEquals(
            ThreadPresentation.Failure("Could not load"),
            ThreadPresenter.present(ThreadLoadState.Failed("Could not load")),
        )
        assertTrue(
            ThreadPresenter.present(ThreadLoadState.Ready(ThreadState())) is ThreadPresentation.Empty,
        )
    }

    private fun everyFeedVariant(): List<FeedItem> = listOf(
        FeedItem.User("user", "hello", 1),
        FeedItem.Text("assistant", "m1", "answer", "assistant", done = true, durationMs = 900),
        FeedItem.Text("reasoning", "m2", "thinking", "reasoning"),
        FeedItem.Text("plan-stream", "m3", "draft", "plan"),
        FeedItem.Tool(
            id = "tool",
            toolId = "t1",
            toolName = "Read",
            input = JsonObject(linkedMapOf("path" to JsonString("README.md"))),
            output = "done",
            state = "done",
        ),
        FeedItem.Denial("denial", "Write", "Plan mode", "plan"),
        FeedItem.Approval("approval", "request-1", "Bash", "npm test", "tool", "pending"),
        FeedItem.Retry("retry", "turn-1", "Retrying after disconnect", active = true),
        FeedItem.Error("error", "Request failed", "turn-1"),
        FeedItem.Plan("plan", "plan-1", "# Plan\nShip it"),
        FeedItem.Question("question", "question-1", listOf(question())),
        FeedItem.FileEdit("file", "edit-1", "/repo", "src/Main.kt", "modify", "old", "new"),
        FeedItem.Drift("drift", "/repo/.switchboard/worktrees/test", "sb/test"),
        FeedItem.SpendBlocked("spend", "work", "gpt", "Budget reached", "daily", 100),
        FeedItem.Peer("peer", "received", "agent", "peer-1", "other", "Other", "Heads up", 2),
        FeedItem.Todo("todo", "todo-1", listOf(TodoEntry("Ship", "completed"))),
        FeedItem.RawNotice(
            "raw",
            "provider.future",
            "Unsupported provider event",
            JsonObject(linkedMapOf("future" to JsonString("kept"))),
        ),
    )

    private fun question() = ThreadQuestion(
        id = "choice",
        header = "Choose",
        question = "Which path?",
        options = listOf(QuestionOption("A", "First"), QuestionOption("B", null)),
        multiSelect = false,
    )
}
