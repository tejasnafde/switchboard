package app.switchboard.mobile.ui.thread

import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.data.remote.ChatDetailsCoordinator
import app.switchboard.mobile.data.remote.ChatDetailsRemote
import app.switchboard.mobile.data.thread.ThreadProfileState
import app.switchboard.mobile.domain.remote.CurrentBranchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.thread.DiffStat
import app.switchboard.mobile.domain.thread.UsageLimits
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The chat Details button shows only with `details_sheet_v1` (a non-null [ThreadDetails]); the open sheet drives the reads. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatDetailsSheetUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val readers = mutableStateOf(ChatDetailsCoordinator(1, "/repo", BackendRemote(answers = true)))
    private val profiles = mutableStateOf(ThreadProfileState())

    private fun screen(withDetails: Boolean = true) = compose.setContent {
        val reader by readers
        val state by reader.state.collectAsState()
        SwitchboardTheme {
            ThreadScreen(
                threadId = "t1",
                title = "Retry uploads",
                backendLabel = "Studio",
                loadState = ThreadLoadState.Loading(),
                onRetry = {},
                onAction = {},
                onBack = {},
                profiles = profiles.value,
                details = if (withDetails) ThreadDetails(reader, state, null, reader::refresh, reader::close) else null,
            )
        }
    }

    @Test
    fun noButtonWithoutTheCapability() {
        screen(withDetails = false)
        compose.onNodeWithTag(ThreadTestTags.DETAILS_ACTION).assertDoesNotExist()
    }

    @Test
    fun theButtonOpensTheSheetWithItsRows() {
        screen()
        compose.onNodeWithContentDescription("Chat details").performClick()

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

    @Test
    fun aNewReaderUnderAnOpenSheetReadsAgain() {
        readers.value = ChatDetailsCoordinator(1, "/repo", BackendRemote(answers = false))
        screen()
        compose.onNodeWithContentDescription("Chat details").performClick()
        compose.onNodeWithText("feat/details").assertDoesNotExist()

        // A reconnect or a rotation gives the open sheet a new reader.
        compose.runOnIdle { readers.value = ChatDetailsCoordinator(1, "/repo", BackendRemote(answers = true)) }

        compose.onNodeWithText("feat/details").assertExists()
        compose.onNodeWithText("+14").assertExists()
    }

    @Test
    fun anAccountChangeWhileOpenReadsThatAccount() {
        val remote = BackendRemote(answers = true)
        readers.value = ChatDetailsCoordinator(1, "/repo", remote)
        screen()
        compose.onNodeWithContentDescription("Chat details").performClick()
        compose.runOnIdle { profiles.value = ThreadProfileState(selectedInstanceId = "claude-work") }
        compose.waitForIdle()

        assertEquals(listOf("claude-code-default", "claude-work"), remote.accounts)
    }

    /** Answers at once when [answers], else never. */
    private class BackendRemote(private val answers: Boolean) : ChatDetailsRemote {
        val accounts = mutableListOf<String>()
        private val accepted = RequestSubmission.Accepted(1, TransportScope("d", "mac", 1))
        private fun <T> answer(callback: (RemoteResponse<T>) -> Unit, value: T): RequestSubmission {
            if (answers) callback(RemoteResponse(RemoteRequestKey("mac", 1, "op"), RemoteOutcome.Success(value)))
            return accepted
        }

        override fun currentBranch(cwd: String, callback: (RemoteResponse<CurrentBranchResult>) -> Unit) =
            answer(callback, CurrentBranchResult.Available("feat/details"))

        override fun diffStat(cwd: String, callback: (RemoteResponse<DiffStat?>) -> Unit) =
            answer(callback, DiffStat(14, 3))

        override fun instanceUsage(instanceId: String, callback: (RemoteResponse<UsageLimits?>) -> Unit): RequestSubmission {
            accounts += instanceId
            return answer(callback, UsageLimits(weeklyUsed = 85.0, sessionUsed = null))
        }
    }
}
