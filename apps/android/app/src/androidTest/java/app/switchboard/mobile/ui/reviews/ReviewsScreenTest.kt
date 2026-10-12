package app.switchboard.mobile.ui.reviews

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.switchboard.mobile.data.remote.PullRequestDetailState
import app.switchboard.mobile.data.remote.ReviewsState
import app.switchboard.mobile.domain.reviews.ChecksRollup
import app.switchboard.mobile.domain.reviews.PhonePrFilters
import app.switchboard.mobile.domain.reviews.PrApprovals
import app.switchboard.mobile.domain.reviews.PrCheck
import app.switchboard.mobile.domain.reviews.PrDetail
import app.switchboard.mobile.domain.reviews.PrLinkChat
import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.reviews.PrPerson
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.PrViewer
import app.switchboard.mobile.domain.reviews.PhoneReviewPill
import app.switchboard.mobile.domain.reviews.WorkOnPrPlan
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ReviewsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val now = 1_791_806_400_000L

    @Test
    fun listShowsSectionsRowsAndOpensADetail() {
        var opened: PrSummary? = null
        var filters: PhonePrFilters? = null
        compose.setContent {
            SwitchboardTheme {
                ReviewsScreen(
                    state = ReviewsState(data = PrListData(listOf(failed()), emptyList(), now, emptyList(), emptyList())),
                    connectionLabel = "MacBook Pro",
                    now = now,
                    onBack = {},
                    onRefresh = {},
                    onQuery = {},
                    onFilters = { filters = it },
                    onUnhideRepos = {},
                    onOpen = { opened = it },
                )
            }
        }
        compose.onNodeWithText("MacBook Pro · 1 open").assertIsDisplayed()
        compose.onNodeWithTag(ReviewsTestTags.section("needs-you")).assertIsDisplayed()
        compose.onNodeWithText("Needs you · 1").assertIsDisplayed()
        compose.onNodeWithTag(ReviewsTestTags.chip("mine")).performClick()
        compose.onNodeWithTag(ReviewsTestTags.row(failed().ref.key)).performClick()
        compose.runOnIdle {
            assertEquals(1482L, opened?.ref?.number)
            assertEquals(app.switchboard.mobile.domain.reviews.PhonePrShow.Mine, filters?.show)
        }
    }

    @Test
    fun emptyListSaysWhatShowsHere() {
        compose.setContent {
            SwitchboardTheme {
                ReviewsScreen(
                    state = ReviewsState(data = PrListData(emptyList(), emptyList(), now, emptyList(), emptyList())),
                    connectionLabel = "MacBook Pro",
                    now = now,
                    onBack = {},
                    onRefresh = {},
                    onQuery = {},
                    onFilters = {},
                    onUnhideRepos = {},
                    onOpen = {},
                )
            }
        }
        compose.onNodeWithText(ReviewsPresenter.EMPTY_TITLE).assertIsDisplayed()
    }

    @Test
    fun detailExpandsChecksInPlaceAndOffersWorkOnPr() {
        var started: WorkOnPrPlan? = null
        var openedWith: Pair<PrLinkChat, PhoneReviewPill?>? = null
        val chat = PrLinkChat("chat-1", listOf("chat-1"), "Fix flaky upload test", "claude-code", "/p/switchboard", now, "created")
        val plan = WorkOnPrPlan("/p/switchboard", "switchboard", null)
        compose.setContent {
            SwitchboardTheme {
                PullRequestDetailScreen(
                    state = PullRequestDetailState(
                        detail = PrDetail(
                            failed(),
                            "Uploads fail with 403.",
                            listOf(PrCheck("unit", "unit", "failure", null, null, 252_000)),
                        ),
                        loading = false,
                        linkedChats = listOf(chat),
                    ),
                    plan = plan,
                    now = now,
                    onBack = {},
                    onRetry = {},
                    onOpenUrl = {},
                    onOpenChat = { c, pill -> openedWith = c to pill },
                    onStartChat = { _, p -> started = p },
                    onLoadLinkableChats = {},
                )
            }
        }
        compose.onNodeWithText("Claude Code · opened by the agent").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag(PullRequestDetailTestTags.CHECKS_ROW).performScrollTo().performClick()
        compose.onNodeWithText("failed · 4m 12s").assertIsDisplayed()
        compose.onNodeWithTag(PullRequestDetailTestTags.ASK_AGENT).performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals("chat-1", openedWith?.first?.id)
            assertTrue(openedWith?.second?.label.orEmpty().startsWith("1 failed check"))
        }
        compose.onNodeWithTag(PullRequestDetailTestTags.WORK_ON_PR).performClick()
        compose.onNodeWithText("In switchboard. The agent checks out the PR first.").assertIsDisplayed()
        compose.onNodeWithTag(PullRequestDetailTestTags.START_CHAT).performClick()
        compose.runOnIdle { assertEquals(plan, started) }
    }

    private fun failed() = PrSummary(
        ref = PrRef("github", "geoiq", "switchboard", 1482),
        title = "Retry uploads when the signed URL expires",
        url = "https://github.com/geoiq/switchboard/pull/1482",
        author = PrPerson("tejas", "tejas", null),
        state = "open",
        draft = false,
        sourceBranch = "fix/upload-retry",
        targetBranch = "main",
        headFromFork = false,
        createdAt = now - 3_600_000,
        updatedAt = now - 720_000,
        mergedAt = null,
        additions = 184,
        deletions = 37,
        changedFiles = 6,
        unresolvedConversations = 3,
        mergeConflicts = false,
        conflictedFiles = emptyList(),
        checks = ChecksRollup("failure", 14, 11, 2, 1),
        reviewers = emptyList(),
        approvals = PrApprovals(1, null),
        viewer = PrViewer(isAuthor = true, isRequestedReviewer = false, hasReviewed = false, hasCommented = false),
        projectPaths = listOf("/p/switchboard"),
    )
}
