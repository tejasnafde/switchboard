package app.switchboard.mobile.ui.thread

import androidx.compose.runtime.getValue
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.data.thread.ThreadArchiveState
import app.switchboard.mobile.data.thread.ThreadProfileState
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.MessagePill
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

class ThreadScreenRegressionTest {
    @Test
    fun userContextPillsRenderAsCompactChipsWithoutLeakingWireSyntax() {
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Thread",
                    backendLabel = "Mac",
                    loadState = ThreadLoadState.Ready(
                        ThreadState(
                            feed = listOf(
                                FeedItem.User(
                                    id = "user",
                                    text = "[[pill:selection-1]] Continue with staging",
                                    at = 1,
                                    pillsMeta = mapOf(
                                        "selection-1" to MessagePill("Admin panel", "chat-message"),
                                    ),
                                ),
                            ),
                        ),
                    ),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                )
            }
        }

        compose.onNodeWithContentDescription("Context: Admin panel").assertIsDisplayed()
        compose.onNodeWithText("[[pill:selection-1]]", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Continue with staging", substring = true).assertIsDisplayed()
    }

    @Test
    fun archiveRequiresConfirmationBeforeInvokingTheBackendAction() {
        var archiveRequests = 0
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Thread",
                    backendLabel = "Mac",
                    loadState = thread("thread"),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                    composer = composer(),
                    archive = ThreadArchiveState(),
                    onArchive = { archiveRequests += 1 },
                )
            }
        }

        compose.onNodeWithContentDescription("Agent settings").performClick()
        compose.onNodeWithTag(ThreadTestTags.ARCHIVE_ACTION).performClick()
        compose.onNodeWithText("Archive this conversation?").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, archiveRequests) }

        compose.onNodeWithTag(ThreadTestTags.ARCHIVE_CONFIRM).performClick()
        compose.runOnIdle { assertEquals(1, archiveRequests) }
    }

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun composerKeepsOneEditableNodeFocusedAndPreservesTextWhenItExpands() {
        var composer by mutableStateOf(composer())
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Thread",
                    backendLabel = "Mac",
                    loadState = thread("thread"),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                    composer = composer,
                    onDraftChange = { composer = composer.copy(draft = it) },
                )
            }
        }

        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT)
            .performClick()
            .performTextInput("hello")

        compose.onAllNodesWithTag(ThreadTestTags.COMPOSER_INPUT).assertCountEquals(1)
        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT)
            .assertIsFocused()
            .assertTextContains("hello")
        compose.onNodeWithContentDescription("Attach image").assertIsDisplayed()
    }

    @Test
    fun composerWithMoreThanFourDummyImagesStillAllowsAnotherAttachment() {
        val attachments = (1..6).map { index ->
            ComposerAttachment(
                id = "dummy-$index",
                privateUri = "/dev/null",
                mimeType = "image/png",
                displayName = "dummy-$index.png",
            )
        }
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Thread",
                    backendLabel = "Mac",
                    loadState = thread("thread"),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                    composer = composer().copy(
                        draft = "keep this draft",
                        attachments = attachments,
                        error = "Images exceed the 3 MiB synchronization limit",
                    ),
                )
            }
        }

        compose.onNodeWithContentDescription("Attach image")
            .assertIsDisplayed()
            .assertIsEnabled()
        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT)
            .assertTextContains("keep this draft")
        compose.onNodeWithText("Images exceed the 3 MiB synchronization limit")
            .assertIsDisplayed()
    }

    @Test
    fun longThreadStartsAtNewestAndSwitchingThreadsResetsToTheNewThreadBottom() {
        var fixture by mutableStateOf(Fixture("first", thread("first")))
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = fixture.id,
                    title = fixture.id,
                    backendLabel = "Mac",
                    loadState = fixture.loadState,
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                )
            }
        }

        compose.onNodeWithTag(ThreadTestTags.FEED).assertIsDisplayed()
        compose.onNodeWithText("first newest").assertIsDisplayed()
        compose.onNodeWithText("first message 0").assertDoesNotExist()

        compose.runOnIdle { fixture = Fixture("second", thread("second")) }

        compose.onNodeWithText("first newest").assertDoesNotExist()
        compose.onNodeWithText("second newest").assertIsDisplayed()
        compose.onNodeWithText("second message 0").assertDoesNotExist()
    }

    @Test
    fun agentSettingsUseAFocusedFullScreenSurfaceAndKeepTheDraft() {
        var composer by mutableStateOf(composer().copy(modelLabel = "gpt-5"))
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Thread",
                    backendLabel = "Mac",
                    loadState = thread("thread"),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                    composer = composer,
                    onDraftChange = { composer = composer.copy(draft = it) },
                )
            }
        }

        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT)
            .performClick()
            .performTextInput("keep me")
        compose.onNodeWithContentDescription("Agent settings")
            .assertHasClickAction()
            .performClick()

        compose.onNodeWithTag(ThreadTestTags.AGENT_SETTINGS_SCREEN).assertIsDisplayed()
        compose.onNodeWithText("Agent settings").assertIsDisplayed()
        compose.onAllNodesWithTag(ThreadTestTags.COMPOSER_INPUT).assertCountEquals(0)

        compose.onNodeWithTag(ThreadTestTags.AGENT_SETTINGS_BACK).performClick()
        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT).assertTextContains("keep me")
    }

    @Test
    fun agentSettingsShowTheActiveProfileAndSwitchWithoutClosingTheDraft() {
        var selected: String? = null
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Thread",
                    backendLabel = "Mac",
                    loadState = thread("thread"),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                    composer = composer().copy(draft = "keep me"),
                    profiles = ThreadProfileState(
                        options = listOf(profile("codex-work", "Work"), profile("codex-tejas", "Tejas")),
                        selectedInstanceId = "codex-work",
                    ),
                    onProfileChange = { selected = it },
                )
            }
        }

        compose.onNodeWithContentDescription("Agent settings").performClick()
        compose.onNodeWithText("PROFILE").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Work").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Tejas").performScrollTo().performClick()
        compose.runOnIdle { assertEquals("codex-tejas", selected) }
        compose.onNodeWithTag(ThreadTestTags.AGENT_SETTINGS_BACK).performClick()
        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT).assertTextContains("keep me")
    }

    @Test
    fun pendingApprovalKeepsItsActionsNearAnOperableComposer() {
        var composerState by mutableStateOf(composer())
        val approval = FeedItem.Approval(
            id = "approval",
            requestId = "request",
            toolName = "Bash",
            detail = "npm test",
            requestType = "tool",
            state = "pending",
        )
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Release",
                    backendLabel = "Mac",
                    loadState = ThreadLoadState.Ready(
                        ThreadState(feed = listOf(approval), status = "running"),
                    ),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                    composer = composerState,
                    onDraftChange = { composerState = composerState.copy(draft = it) },
                )
            }
        }

        compose.onNodeWithTag(ThreadTestTags.APPROVAL_SLOT).assertIsDisplayed()
        compose.onNodeWithText("Approval needed").assertIsDisplayed()
        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT).performTextInput("follow up")
        compose.onNodeWithTag(ThreadTestTags.COMPOSER_INPUT).assertTextContains("follow up")
    }

    @Test
    fun fileEditOffersBoundedReadOnlyReviewWhenRemoteMutationIsUnsafe() {
        val edit = FeedItem.FileEdit(
            id = "edit",
            fileEditId = "file-edit",
            repoRoot = "/repo",
            relPath = "src/App.kt",
            changeKind = "modify",
            oldContent = "old",
            newContent = "new",
        )
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Release",
                    backendLabel = "Mac",
                    loadState = ThreadLoadState.Ready(ThreadState(feed = listOf(edit))),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                )
            }
        }

        compose.onNodeWithText("Changed on Mac", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Review").performClick()
        compose.onNodeWithText("old").assertIsDisplayed()
        compose.onNodeWithText("new").assertIsDisplayed()
        compose.onNodeWithText("Read-only preview").assertIsDisplayed()
        compose.onNodeWithText("Open file").assertDoesNotExist()
    }

    @Test
    fun contextCostAndDurationAreVisibleAsOneAccessibleSummary() {
        compose.setContent {
            SwitchboardTheme {
                ThreadScreen(
                    threadId = "thread",
                    title = "Release",
                    backendLabel = "Mac",
                    loadState = ThreadLoadState.Ready(
                        ThreadState(
                            feed = listOf(FeedItem.User("user", "hello", 1)),
                            status = "running",
                            usedTokens = 1_500,
                            maxTokens = 2_000,
                            costUsd = 0.42,
                            lastTurnDurationMs = 1_250,
                        ),
                    ),
                    onRetry = {},
                    onAction = {},
                    onBack = {},
                )
            }
        }

        compose.onNodeWithContentDescription(
            "1,500 / 2,000 tokens, \$0.42, 1.3s",
        ).assertIsDisplayed()
    }

    @Test
    fun collapsedToolShowsUsefulSummaryAtOneAccessible48DpTarget() {
        val output = "hidden output that must not enter collapsed semantics"
        setTools(
            listOf(tool("tool", "Bash", "command" to "npm test -- --runInBand", output = output)),
        )

        val row = compose.onNodeWithTag(ThreadTestTags.toolRow("tool"))
        row.assertIsDisplayed()
            .assertTextContains("Bash")
            .assertTextContains("npm test -- --runInBand")
            .assertHeightIsEqualTo(48.dp)
            .assertWidthIsAtLeast(48.dp)
            .assertHasClickAction()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Completed, collapsed"))
        compose.onNodeWithText("Input").assertDoesNotExist()
        compose.onNodeWithText(output, substring = true).assertDoesNotExist()
        compose.onNodeWithTag(ThreadTestTags.toolOutput("tool")).assertDoesNotExist()
        compose.onNodeWithTag(ThreadTestTags.toolStatus("tool"), useUnmergedTree = false).assertDoesNotExist()
        compose.onNodeWithTag(ThreadTestTags.toolStatus("tool"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun completedOutputDisclosesAndCollapsesOnlyThatToolsSelectableBody() {
        setTools(
            listOf(
                tool("first", "Read", "path" to "README.md", output = "first output"),
                tool("second", "Read", "path" to "CHANGELOG.md", output = "second output"),
            ),
        )

        val first = compose.onNodeWithTag(ThreadTestTags.toolRow("first"))
        first.performClick()
        first.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Completed, expanded"))
        compose.onNodeWithTag(ThreadTestTags.toolOutput("first")).assertIsDisplayed()
        compose.onNodeWithText("first output").assertIsDisplayed()
        compose.onNodeWithText("second output").assertDoesNotExist()

        first.performClick()
        first.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Completed, collapsed"))
        compose.onNodeWithText("first output").assertDoesNotExist()
    }

    @Test
    fun completedBlankOutputHasNoFalseDisclosureOrButtonRole() {
        setTools(listOf(tool("blank", "Read", "path" to "README.md", output = "  ")))

        compose.onNodeWithTag(ThreadTestTags.toolRow("blank"))
            .assertHasNoClickAction()
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Role))
        compose.onNodeWithTag(ThreadTestTags.toolDisclosure("blank"), useUnmergedTree = true)
            .assertDoesNotExist()
    }

    @Test
    fun runningToolUsesAStableSpinnerSlotAndExplicitRunningState() {
        setTools(listOf(tool("running", "Bash", "command" to "npm test", state = "running")))

        compose.onNodeWithTag(ThreadTestTags.toolRow("running"))
            .assertHasNoClickAction()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Running"))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Role))
        compose.onNodeWithTag(ThreadTestTags.toolStatus("running"), useUnmergedTree = true)
            .assertIsDisplayed()
        compose.onNodeWithTag(ThreadTestTags.toolDisclosure("running"), useUnmergedTree = true)
            .assertDoesNotExist()
    }

    @Test
    fun expansionSurvivesUnrelatedFeedAndOutputUpdates() {
        var feed by mutableStateOf<List<FeedItem>>(
            listOf(
                tool("inspected", "Read", "path" to "README.md", output = "keep visible"),
                tool("late", "Grep", "pattern" to "ThreadRow", state = "running"),
            ),
        )
        setDynamicTools { feed }
        compose.onNodeWithTag(ThreadTestTags.toolRow("inspected")).performClick()

        compose.runOnIdle {
            feed = feed.map {
                if (it is FeedItem.Tool && it.id == "late") {
                    it.copy(state = "done", output = "late output")
                } else {
                    it
                }
            } + FeedItem.User("unrelated", "new message", 2)
        }

        compose.onNodeWithText("keep visible").assertIsDisplayed()
        compose.onNodeWithTag(ThreadTestTags.toolDisclosure("late"), useUnmergedTree = true)
            .assertExists()
        compose.onNodeWithText("late output").assertDoesNotExist()
    }

    @Test
    fun runningCompletionUpdatesInPlaceWithoutReorderingChronologicalFeed() {
        var feed by mutableStateOf(
            listOf(
                tool("first", "Read", "path" to "first.kt"),
                tool("middle", "Bash", "command" to "npm test", state = "running"),
                tool("last", "WebSearch", "query" to "Compose semantics"),
            ),
        )
        setDynamicTools { feed }
        assertVisualOrder("first", "middle", "last")

        compose.runOnIdle {
            feed = feed.map {
                if (it.id == "middle") it.copy(state = "done", output = "passed") else it
            }
        }

        compose.onAllNodesWithTag(ThreadTestTags.toolRow("middle")).assertCountEquals(1)
        assertVisualOrder("first", "middle", "last")
        compose.onNodeWithTag(ThreadTestTags.toolDisclosure("middle"), useUnmergedTree = true)
            .assertExists()
    }

    @Test
    fun largeFontKeepsLabelDetailAndDisclosureInNonOverlappingSlots() {
        setTools(
            listOf(
                tool(
                    "large-font",
                    "Bash",
                    "command" to "a very long command whose visual detail must ellipsize before the disclosure",
                    output = "output",
                ),
            ),
            fontScale = 2f,
        )

        val label = compose.onNodeWithTag(ThreadTestTags.toolLabel("large-font"), useUnmergedTree = true)
            .fetchSemanticsNode().boundsInRoot
        val detail = compose.onNodeWithTag(ThreadTestTags.toolDetail("large-font"), useUnmergedTree = true)
            .fetchSemanticsNode().boundsInRoot
        val disclosure = compose.onNodeWithTag(ThreadTestTags.toolDisclosure("large-font"), useUnmergedTree = true)
            .fetchSemanticsNode().boundsInRoot

        assertTrue(label.right <= detail.left)
        assertTrue(detail.right <= disclosure.left)
        compose.onNodeWithTag(ThreadTestTags.toolRow("large-font")).assertHeightIsEqualTo(48.dp)
    }

    @Test
    fun tenToolFeedStaysScrollableAtCompactRowHeight() {
        setTools(
            (0 until 10).map { index ->
                tool("tool-$index", "Bash", "command" to "command $index")
            },
        )

        compose.onNodeWithTag(ThreadTestTags.toolRow("tool-0"))
            .performScrollTo()
            .assertIsDisplayed()
            .assertHeightIsEqualTo(48.dp)
        compose.onNodeWithTag(ThreadTestTags.toolRow("tool-9"))
            .performScrollTo()
            .assertIsDisplayed()
            .assertHeightIsEqualTo(48.dp)
    }

    private fun composer() = ThreadComposerPresentation(
        draft = "",
        runtimeMode = RuntimeMode.Sandbox,
        submitting = false,
        interrupting = false,
        modeChanging = false,
        error = null,
        controlMessage = null,
        focusRequest = 0,
        showInterrupt = false,
    )

    private fun thread(prefix: String): ThreadLoadState.Ready {
        val feed = (0 until 80).map { index ->
            FeedItem.User("$prefix-$index", "$prefix message $index", index.toLong())
        } + FeedItem.User("$prefix-newest", "$prefix newest", 80)
        return ThreadLoadState.Ready(ThreadState(feed = feed, status = "idle"))
    }

    private fun profile(id: String, name: String) = ProviderInstance(
        id = id,
        agentType = "codex",
        displayName = name,
        accentColor = null,
        authMode = "oauth_dir",
        envKeys = emptyList(),
        oauthDir = null,
        enabled = true,
        createdAt = 1,
        updatedAt = 1,
        raw = app.switchboard.mobile.protocol.JsonObject(linkedMapOf()),
    )

    private fun setTools(feed: List<FeedItem>, fontScale: Float = 1f) {
        setDynamicTools(fontScale) { feed }
    }

    private fun setDynamicTools(
        fontScale: Float = 1f,
        feed: () -> List<FeedItem>,
    ) {
        compose.setContent {
            SwitchboardTheme {
                val density = LocalDensity.current
                CompositionLocalProvider(
                    LocalDensity provides Density(density.density, fontScale),
                ) {
                    ThreadScreen(
                        threadId = "tools-thread",
                        title = "Tools",
                        backendLabel = "Mac",
                        loadState = ThreadLoadState.Ready(ThreadState(feed = feed())),
                        onRetry = {},
                        onAction = {},
                        onBack = {},
                    )
                }
            }
        }
    }

    private fun tool(
        id: String,
        name: String,
        input: Pair<String, String>,
        state: String = "done",
        output: String? = null,
    ) = FeedItem.Tool(
        id = id,
        toolId = id,
        toolName = name,
        input = JsonObject(linkedMapOf(input.first to JsonString(input.second))),
        output = output,
        state = state,
    )

    private fun assertVisualOrder(vararg ids: String) {
        val tops = ids.map { id ->
            compose.onNodeWithTag(ThreadTestTags.toolRow(id)).fetchSemanticsNode().boundsInRoot.top
        }
        assertTrue(tops.zipWithNext().all { (first, second) -> first < second })
    }

    private data class Fixture(
        val id: String,
        val loadState: ThreadLoadState.Ready,
    )
}
