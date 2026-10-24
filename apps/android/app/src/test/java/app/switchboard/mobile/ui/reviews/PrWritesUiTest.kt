package app.switchboard.mobile.ui.reviews

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.data.remote.PrWritePhase
import app.switchboard.mobile.data.remote.PrWriteSheetState
import app.switchboard.mobile.data.remote.PrWriteState
import app.switchboard.mobile.data.remote.PrWriteTarget
import app.switchboard.mobile.domain.reviews.ChecksRollup
import app.switchboard.mobile.domain.reviews.PhonePrWrites
import app.switchboard.mobile.domain.reviews.PrApprovals
import app.switchboard.mobile.domain.reviews.PrComment
import app.switchboard.mobile.domain.reviews.PrConversation
import app.switchboard.mobile.domain.reviews.PrPerson
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.PrViewer
import app.switchboard.mobile.domain.reviews.ReviewEvent
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrWritesUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val thread = PrConversation(
        id = "PRRT_1",
        path = "src/main/backend/device-sessions.ts",
        line = 88,
        startLine = null,
        resolved = false,
        outdated = false,
        comments = listOf(PrComment("1", PrPerson("mira-k", "Mira", null), "Should the token hash use a pepper too?", 0)),
    )

    private val pr = PrSummary(
        ref = PrRef("github", "geoiq", "switchboard", 412),
        title = "Device sessions: per-device scopes",
        url = "",
        author = PrPerson("mira-k", "Mira", null),
        state = "open",
        draft = false,
        sourceBranch = "scopes",
        targetBranch = "main",
        headFromFork = false,
        createdAt = 0,
        updatedAt = 0,
        mergedAt = null,
        additions = null,
        deletions = null,
        changedFiles = null,
        unresolvedConversations = 1,
        mergeConflicts = false,
        conflictedFiles = emptyList(),
        checks = ChecksRollup("success", 1, 1, 0, 0),
        reviewers = emptyList(),
        approvals = PrApprovals(0, null),
        viewer = PrViewer(isAuthor = false, isRequestedReviewer = true, hasReviewed = false, hasCommented = false),
        projectPaths = emptyList(),
    )

    private fun show(state: PrWriteState, actions: PrWriteActions = PrWriteActions()) {
        compose.setContent {
            SwitchboardTheme {
                Column {
                    PrConversationsSection(state, pr, actions)
                    PrWriteOverlays(state, pr, actions)
                }
            }
        }
    }

    @Test
    fun withoutTheCapabilityThereIsNoSection() {
        show(PrWriteState(supported = false, scopes = listOf(PhonePrWrites.SCOPE), conversations = listOf(thread)))
        compose.onNodeWithTag(PrWriteTestTags.SECTION).assertDoesNotExist()
    }

    @Test
    fun withoutTheScopeThreadsAreReadOnlyWithTheNote() {
        show(PrWriteState(supported = true, scopes = listOf("chat"), conversations = listOf(thread)))
        compose.onNodeWithText(thread.location).assertExists()
        compose.onNodeWithTag(PrWriteTestTags.NO_SCOPE).assertExists()
        compose.onNodeWithText(PhonePrWrites.Copy.NO_SCOPE_TITLE).assertExists()
        compose.onNodeWithTag(PrWriteTestTags.reply(thread.id)).assertDoesNotExist()
        compose.onNodeWithTag(PrWriteTestTags.resolve(thread.id)).assertDoesNotExist()
        compose.onNodeWithTag(PrWriteTestTags.COMMENT).assertDoesNotExist()
        compose.onNodeWithTag(PrWriteTestTags.REVIEW).assertDoesNotExist()
    }

    @Test
    fun withTheScopeEachOpenThreadOffersReplyAndResolve() {
        val composed = mutableListOf<PrWriteTarget>()
        show(
            PrWriteState(supported = true, scopes = listOf(PhonePrWrites.SCOPE), conversations = listOf(thread)),
            PrWriteActions(onCompose = { composed += it }),
        )
        compose.onNodeWithTag(PrWriteTestTags.NO_SCOPE).assertDoesNotExist()
        compose.onNodeWithTag(PrWriteTestTags.resolve(thread.id)).assertExists()
        compose.onNodeWithTag(PrWriteTestTags.reply(thread.id)).performClick()
        compose.onNodeWithTag(PrWriteTestTags.REVIEW).performClick()
        assertEquals(listOf(PrWriteTarget.Reply(thread), PrWriteTarget.Review(ReviewEvent.Approve)), composed)
    }

    @Test
    fun anApproveSheetNamesTheAccountAndSaysItDoesNotMerge() {
        show(
            PrWriteState(
                supported = true,
                scopes = listOf(PhonePrWrites.SCOPE),
                conversations = emptyList(),
                sheet = PrWriteSheetState(PrWriteTarget.Review(ReviewEvent.Approve), "Looks good.", account = "tejas-geoiq"),
            ),
        )
        compose.onNodeWithText("Approve pull request?").assertExists()
        compose.onNodeWithText("tejas-geoiq").assertExists()
        compose.onNodeWithText(PhonePrWrites.Copy.APPROVE_NOTE).assertExists()
        compose.onNodeWithTag(PrWriteTestTags.SHEET_POST).assertIsEnabled()
    }

    @Test
    fun anUncertainSheetOffersOnlyCheckThread() {
        show(
            PrWriteState(
                supported = true,
                scopes = listOf(PhonePrWrites.SCOPE),
                conversations = listOf(thread),
                sheet = PrWriteSheetState(PrWriteTarget.Reply(thread), "Done.", account = "tejas-geoiq", phase = PrWritePhase.Uncertain),
            ),
        )
        compose.onNodeWithText(PhonePrWrites.Copy.NOT_SURE_TITLE).assertExists()
        compose.onNodeWithTag(PrWriteTestTags.CHECK_THREAD).assertExists()
        compose.onNodeWithTag(PrWriteTestTags.SHEET_POST).assertDoesNotExist()
    }
}
