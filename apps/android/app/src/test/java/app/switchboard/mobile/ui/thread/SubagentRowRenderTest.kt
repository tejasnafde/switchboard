package app.switchboard.mobile.ui.thread

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SubagentRowRenderTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun agentRow(output: String?, state: String, isError: Boolean = false): ThreadRowPresentation.Subagent {
        val input = JsonObject(linkedMapOf("description" to JsonString("Audit deps"), "model" to JsonString("haiku")))
        val feed = listOf(
            FeedItem.Tool("t-A", "A", "Agent", input, output, state, isError = isError),
            FeedItem.Tool(
                "t-B", "B", "Bash", JsonObject(linkedMapOf("command" to JsonString("npm ls"))), "Exit code 1", "done",
                parentToolCallId = "A", isError = isError,
            ),
        )
        return ThreadPresenter.feedRows(feed).single() as ThreadRowPresentation.Subagent
    }

    @Test
    fun aRunningAgentShowsItsCurrentStep() {
        val row = agentRow(output = null, state = "running")
        compose.setContent { SwitchboardTheme { SubagentRow(row) } }

        compose.onNodeWithText("Audit deps").assertIsDisplayed()
        compose.onNodeWithText("haiku").assertIsDisplayed()
        compose.onNodeWithTag(ThreadTestTags.subagentStatusText("t-A"), useUnmergedTree = true)
            .assertTextEquals("Step 1 · npm ls")
    }

    @Test
    fun aFailedAgentSaysFailedAndOpensOnItsFailedStep() {
        val row = agentRow(output = "<tool_use_error>npm ls exited 1</tool_use_error>", state = "done", isError = true)
        compose.setContent { SwitchboardTheme { SubagentRow(row) } }

        compose.onNodeWithTag(ThreadTestTags.subagentStatusText("t-A"), useUnmergedTree = true)
            .assertTextEquals("Failed · npm ls exited 1 · 1 step")
        compose.onNodeWithTag(ThreadTestTags.subagentRow("t-A")).performClick()
        compose.onNodeWithTag(ThreadTestTags.subagentSteps("t-A")).assertIsDisplayed()
        compose.onNodeWithTag(ThreadTestTags.toolOutput("t-B"), useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun aDoneAgentShowsItsReportWhenExpanded() {
        val row = agentRow(output = "All deps current.\nagentId: a1 (internal)", state = "done")
        compose.setContent { SwitchboardTheme { SubagentRow(row) } }

        compose.onNodeWithTag(ThreadTestTags.subagentStatusText("t-A"), useUnmergedTree = true)
            .assertTextEquals("Done · 1 step")
        compose.onNodeWithTag(ThreadTestTags.subagentRow("t-A")).performClick()
        compose.onNodeWithTag(ThreadTestTags.subagentResult("t-A"), useUnmergedTree = true)
            .assertTextEquals("All deps current.")
    }
}
