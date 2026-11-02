package app.switchboard.mobile.ui.thread

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.data.remote.ChatDetailsState
import app.switchboard.mobile.domain.thread.BranchName
import app.switchboard.mobile.domain.thread.DetailsRead
import app.switchboard.mobile.domain.thread.DiffStat
import app.switchboard.mobile.domain.thread.UsageLimits
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The chat Details button shows only with `details_sheet_v1` (a non-null [ThreadDetails]) and opens the sheet. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatDetailsSheetUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun screen(details: ThreadDetails?) = compose.setContent {
        SwitchboardTheme {
            ThreadScreen(
                threadId = "t1",
                title = "Retry uploads",
                backendLabel = "Studio",
                loadState = ThreadLoadState.Loading(),
                onRetry = {},
                onAction = {},
                onBack = {},
                details = details,
            )
        }
    }

    @Test
    fun noButtonWithoutTheCapability() {
        screen(null)
        compose.onNodeWithTag(ThreadTestTags.DETAILS_ACTION).assertDoesNotExist()
    }

    @Test
    fun theButtonReadsAndOpensTheSheet() {
        val opened = mutableListOf<String>()
        val state = ChatDetailsState(
            branch = DetailsRead.Read(BranchName("feat/details")),
            diff = DetailsRead.Read(DiffStat(14, 3)),
            usage = UsageLimits(weeklyUsed = 85.0, sessionUsed = null),
        )
        screen(ThreadDetails(state, prList = null, onOpen = { opened += it }, onClose = {}))

        compose.onNodeWithContentDescription("Chat details").performClick()

        assertEquals(listOf("claude-code-default"), opened)
        compose.onNodeWithTag(ThreadTestTags.DETAILS_SHEET).assertExists()
        // The machine row, and the app bar subtitle before the chat loads.
        compose.onAllNodesWithText("Studio").assertCountEquals(2)
        compose.onNodeWithText("feat/details").assertExists()
        compose.onNodeWithText("+14").assertExists()
        compose.onNodeWithText("-3").assertExists()
        compose.onNodeWithContentDescription("Weekly, 15 percent left").assertExists()
        compose.onNodeWithContentDescription("5-hour session, unavailable").assertExists()
        compose.onNodeWithContentDescription("Context, unavailable").assertExists()
    }
}
