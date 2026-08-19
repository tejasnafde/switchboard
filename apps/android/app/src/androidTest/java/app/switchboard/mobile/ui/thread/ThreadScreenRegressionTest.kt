package app.switchboard.mobile.ui.thread

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Rule
import org.junit.Test

class ThreadScreenRegressionTest {
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
        compose.onNodeWithTag(ThreadTestTags.AGENT_SETTINGS_ACTION)
            .assertHasClickAction()
            .performClick()

        compose.onNodeWithTag(ThreadTestTags.AGENT_SETTINGS_SCREEN).assertIsDisplayed()
        compose.onNodeWithText("Agent settings").assertIsDisplayed()
        compose.onAllNodesWithTag(ThreadTestTags.COMPOSER_INPUT).assertCountEquals(0)

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
    fun fileEditIsInformationalWhenRemoteOpenIsUnsupported() {
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

    private data class Fixture(
        val id: String,
        val loadState: ThreadLoadState.Ready,
    )
}
