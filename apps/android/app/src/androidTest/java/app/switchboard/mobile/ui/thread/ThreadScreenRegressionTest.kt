package app.switchboard.mobile.ui.thread

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
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
        compose.onNodeWithText("Image").assertIsDisplayed()
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
