package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.QuestionOption
import app.switchboard.mobile.domain.thread.ThreadQuestion
import app.switchboard.mobile.domain.thread.TodoEntry
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals("README.md", tool.detail)
        assertEquals("done", tool.output)
        val file = content.rows.filterIsInstance<ThreadRowPresentation.FileEdit>().single()
        assertEquals(1, file.addedLines)
        assertEquals(1, file.removedLines)
        assertEquals("src/Main.kt", file.relPath)
        assertEquals(
            listOf(DiffLineKind.Removed, DiffLineKind.Added),
            file.diff.lines.map(CompactDiffLine::kind),
        )
        val raw = content.rows.filterIsInstance<ThreadRowPresentation.RawNotice>().single()
        assertEquals("provider.future", raw.eventType)
        assertEquals("{\"future\":\"kept\"}", raw.raw)
    }

    @Test
    fun toolRowsPresentOneUsefulBoundedLineInsteadOfRawJson() {
        val row = ThreadPresenter.row(
            FeedItem.Tool(
                id = "tool",
                toolId = "tool-1",
                toolName = "Bash",
                input = JsonObject(
                    linkedMapOf(
                        "command" to JsonString("npm test\n-- --runInBand"),
                        "description" to JsonString("ignored metadata"),
                    ),
                ),
                state = "done",
            ),
        ) as ThreadRowPresentation.Tool

        assertEquals("npm test -- --runInBand", row.detail)
        assertTrue(row.detail.length <= 140)
    }

    @Test
    fun shellArrayCommandsHaveNormalizedPresentationWithoutChangingTheirStableKey() {
        val row = ThreadPresenter.row(
            FeedItem.Tool(
                id = "stable-tool-row",
                toolId = "provider-tool-id",
                toolName = "shell",
                input = JsonArray(listOf()),
                state = "running",
            ).copy(
                input = JsonObject(
                    linkedMapOf(
                        "command" to JsonArray(
                            listOf(JsonString("npm"), JsonString("test"), JsonString("--runInBand")),
                        ),
                    ),
                ),
            ),
        ) as ThreadRowPresentation.Tool

        assertEquals("stable-tool-row", row.key)
        assertEquals("Bash", row.label)
        assertEquals("npm test --runInBand", row.detail)
        assertEquals(ToolIconKind.SHELL, row.iconKind)
        assertTrue(row.monospaceDetail)
        assertEquals(ToolActivityState.RUNNING, row.activityState)
    }

    @Test
    fun shellAliasesSupportStringAndArrayCommands() {
        val stringCommand = toolRow(
            name = "Bash",
            input = obj("command" to JsonString("npm   test\n-- --runInBand")),
        )
        val arrayCommand = toolRow(
            name = "exec_command",
            input = obj(
                "command" to JsonArray(
                    listOf(JsonString("git"), JsonString("status"), JsonNumber("7")),
                ),
            ),
        )

        assertEquals("Bash", stringCommand.label)
        assertEquals("npm test -- --runInBand", stringCommand.detail)
        assertEquals("git status", arrayCommand.detail)
        assertEquals(ToolIconKind.SHELL, arrayCommand.iconKind)
        assertTrue(stringCommand.monospaceDetail)
    }

    @Test
    fun fileAndNotebookAliasesPresentTheirPath() {
        val cases = listOf(
            Triple("read_file", obj("path" to JsonString("README.md")), "Read" to ToolIconKind.READ),
            Triple("write-file", obj("filePath" to JsonString("src/App.kt")), "Write" to ToolIconKind.WRITE),
            Triple("apply_patch", obj("file_path" to JsonString("src/Main.kt")), "Edit" to ToolIconKind.EDIT),
            Triple("NotebookRead", obj("notebook_path" to JsonString("analysis.ipynb")), "Read notebook" to ToolIconKind.NOTEBOOK),
            Triple("notebook_edit", obj("path" to JsonString("notes.ipynb")), "Edit notebook" to ToolIconKind.NOTEBOOK),
        )

        cases.forEach { (name, input, expected) ->
            val row = toolRow(name, input)
            assertEquals(name, expected.first, row.label)
            assertEquals(name, expected.second, row.iconKind)
            assertTrue(name, row.detail.isNotBlank())
            assertTrue(name, row.monospaceDetail)
        }
    }

    @Test
    fun searchAliasesPresentPatternsAndScopesWithoutRawJson() {
        val grep = toolRow(
            "search_files",
            obj(
                "pattern" to JsonString("ThreadRow"),
                "path" to JsonString("apps/android"),
            ),
        )
        val glob = toolRow("file_glob", obj("query" to JsonString("**/Thread*.kt")))
        val list = toolRow("list-files", obj("directory" to JsonString("apps/android")))

        assertEquals("Grep", grep.label)
        assertEquals("\"ThreadRow\" in apps/android", grep.detail)
        assertEquals(ToolIconKind.SEARCH, grep.iconKind)
        assertEquals("Glob", glob.label)
        assertEquals("**/Thread*.kt", glob.detail)
        assertEquals("List files", list.label)
        assertEquals("apps/android", list.detail)
    }

    @Test
    fun webAliasesPresentUrlsAndQueries() {
        val fetch = toolRow("web_fetch", obj("uri" to JsonString("https://example.com/docs")))
        val search = toolRow("WebSearch", obj("q" to JsonString("Compose merged semantics")))

        assertEquals("Web", fetch.label)
        assertEquals("https://example.com/docs", fetch.detail)
        assertEquals(ToolIconKind.WEB, fetch.iconKind)
        assertTrue(fetch.monospaceDetail)
        assertEquals("Web", search.label)
        assertEquals("Compose merged semantics", search.detail)
        assertFalse(search.monospaceDetail)
    }

    @Test
    fun taskAndSubagentAliasesPresentDescriptions() {
        listOf("task", "subagent", "spawn_agent").forEach { name ->
            val row = toolRow(name, obj("description" to JsonString("Audit provider lifecycle")))
            assertEquals(name, "Task", row.label)
            assertEquals(name, "Audit provider lifecycle", row.detail)
            assertEquals(name, ToolIconKind.TASK, row.iconKind)
            assertFalse(name, row.monospaceDetail)
        }
    }

    @Test
    fun unknownAndMcpToolsDegradeToReadableBoundedSummaries() {
        val unknown = toolRow(
            "custom_provider_action",
            obj("command" to JsonString("do the useful thing")),
        )
        val mcp = toolRow(
            "mcp__linear__create_issue",
            obj("description" to JsonString("Track Android density")),
        )
        val keysOnly = toolRow(
            "WeirdTool",
            obj(
                "project_id" to JsonString("switchboard"),
                "labels" to JsonArray(emptyList()),
            ),
        )

        assertEquals("Custom provider action", unknown.label)
        assertEquals("do the useful thing", unknown.detail)
        assertEquals(ToolIconKind.OTHER, unknown.iconKind)
        assertEquals("Create issue", mcp.label)
        assertEquals("Track Android density", mcp.detail)
        assertEquals("Weird tool", keysOnly.label)
        assertEquals("project id, labels", keysOnly.detail)
        assertFalse(keysOnly.detail.startsWith("{"))
    }

    @Test
    fun nullScalarArrayAndMalformedInputShapesNeverCrashOrDumpJson() {
        val inputs = listOf(null, JsonNull, JsonString("raw"), JsonNumber("42"), JsonBoolean(true), JsonArray(listOf(JsonString("raw"))))

        inputs.forEachIndexed { index, input ->
            val row = toolRow("unknown_tool", input)
            assertEquals(index.toString(), "Unknown tool", row.label)
            assertEquals(index.toString(), "", row.detail)
        }
    }

    @Test
    fun everyToolDetailNormalizesWhitespaceAndStopsAt140Characters() {
        val row = toolRow(
            "task",
            obj("prompt" to JsonString("  audit\n\t" + "x".repeat(200) + "  ")),
        )

        assertEquals(140, row.detail.length)
        assertTrue(row.detail.startsWith("audit x"))
        assertTrue(row.detail.endsWith("…"))
        assertFalse(row.detail.contains('\n'))
        assertFalse(row.detail.contains('\t'))
    }

    @Test
    fun activityStateAndDisclosureDataAreNormalizedWithoutDisplayingRawDone() {
        val running = toolRow("bash", obj("command" to JsonString("npm test")), state = "running")
        val blank = toolRow("bash", obj("command" to JsonString("npm test")), output = "  ")
        val complete = toolRow("bash", obj("command" to JsonString("npm test")), output = "passed")

        assertEquals(ToolActivityState.RUNNING, running.activityState)
        assertFalse(running.hasOutput)
        assertEquals(ToolActivityState.COMPLETED, blank.activityState)
        assertFalse(blank.hasOutput)
        assertEquals(ToolActivityState.COMPLETED, complete.activityState)
        assertTrue(complete.hasOutput)
    }

    @Test
    fun runningToCompletedPresentationKeepsTheSameStableIdentity() {
        val started = FeedItem.Tool(
            id = "t-provider-id",
            toolId = "provider-id",
            toolName = "Read",
            input = obj("path" to JsonString("README.md")),
            state = "running",
        )
        val running = ThreadPresenter.row(started) as ThreadRowPresentation.Tool
        val completed = ThreadPresenter.row(started.copy(state = "done", output = "contents"))
            as ThreadRowPresentation.Tool

        assertEquals(running.key, completed.key)
        assertEquals("t-provider-id", completed.key)
        assertEquals(ToolActivityState.RUNNING, running.activityState)
        assertEquals(ToolActivityState.COMPLETED, completed.activityState)
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
        assertEquals("1,500 / 2,000 tokens", metadata.contextLabel)
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

    private fun toolRow(
        name: String,
        input: app.switchboard.mobile.protocol.JsonValue?,
        state: String = "done",
        output: String? = null,
    ): ThreadRowPresentation.Tool = ThreadPresenter.row(
        FeedItem.Tool(
            id = "tool-$name",
            toolId = "provider-$name",
            toolName = name,
            input = input,
            output = output,
            state = state,
        ),
    ) as ThreadRowPresentation.Tool

    private fun obj(vararg entries: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(linkedMapOf(*entries))
}
