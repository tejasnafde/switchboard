package app.switchboard.mobile.ui.reviews

import app.switchboard.mobile.data.remote.ReviewsState
import app.switchboard.mobile.domain.reviews.ChecksRollup
import app.switchboard.mobile.domain.reviews.PhonePrShow
import app.switchboard.mobile.domain.reviews.PhonePrTone
import app.switchboard.mobile.domain.reviews.PrApprovals
import app.switchboard.mobile.domain.reviews.PrGroupId
import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.reviews.PrPerson
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrRowIcon
import app.switchboard.mobile.domain.reviews.PrRowStatus
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.PrViewer
import app.switchboard.mobile.domain.reviews.PullRequestRefresh
import app.switchboard.mobile.domain.reviews.PullRequestRefresh.Reason
import app.switchboard.mobile.domain.reviews.RepoRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewsPresenterTest {
    private val now = 10L * 24 * 60 * 60 * 1000

    @Test
    fun nothingOpenOffersThisWeeksMerges() {
        val state = ReviewsState(data = data(merged(1), merged(2)))
        val empty = ReviewsPresenter.present(state, "Mac", now, showMerged = false)
        assertEquals(ReviewsBody.NothingOpen(2), empty.body)
        assertEquals("Mac · nothing open", empty.subtitle)
        val shown = ReviewsPresenter.present(state, "Mac", now, showMerged = true).body as ReviewsBody.Sections
        assertEquals(listOf(PrGroupId.Merged.wire), shown.sections.map { it.key })
    }

    @Test
    fun aFailedRefreshOverAnOlderListSaysWhenItWasRead() {
        val state = ReviewsState(
            data = data(open(1)),
            error = "offline",
            lastSuccessAt = now - 4 * 60_000,
        )
        val presentation = ReviewsPresenter.present(state, "Mac", now, showMerged = false)
        assertEquals("Last read from the desktop 4 min ago", presentation.staleNote)
        assertEquals("Mac · 1 open", presentation.subtitle)
        assertNull(ReviewsPresenter.present(state.copy(error = null), "Mac", now, false).staleNote)
    }

    @Test
    fun hiddenRepositoriesAndNoListYet() {
        val hidden = ReviewsState(data = data(open(1)).copy(hiddenRepos = listOf(RepoRef("github", "a", "b"), RepoRef("github", "a", "c"))))
        assertEquals("2 repositories hidden", ReviewsPresenter.present(hidden, "Mac", now, false).hiddenReposLabel)
        assertEquals(ReviewsBody.Loading, ReviewsPresenter.present(ReviewsState(), "Mac", now, false).body)
        assertEquals(ReviewsBody.Failure("down"), ReviewsPresenter.present(ReviewsState(error = "down"), "Mac", now, false).body)
        assertEquals(ReviewsBody.NoMatch, ReviewsPresenter.present(hidden.copy(query = "zzz"), "Mac", now, false).body)
    }

    @Test
    fun phrasesAndChips() {
        assertEquals(PhonePrTone.Failure, ReviewsPresenter.phraseTone(PrRowStatus(PrGroupId.NeedsYou, PrRowIcon.Failed, "build failed")))
        assertEquals(PhonePrTone.Pending, ReviewsPresenter.phraseTone(PrRowStatus(PrGroupId.Yours, PrRowIcon.Running, "checks running")))
        assertEquals(PhonePrTone.Success, ReviewsPresenter.phraseTone(PrRowStatus(PrGroupId.Yours, PrRowIcon.Waiting, "1 of 2 approvals")))
        assertEquals("Needs you · 2", ReviewsPresenter.chipLabel(PhonePrShow.NeedsYou, 2))
        assertEquals("Mine", ReviewsPresenter.chipLabel(PhonePrShow.Mine, 2))
    }

    @Test
    fun refreshRule() {
        val idle = PullRequestRefresh.State(lastFetchAt = 0, inFlight = false, visible = true)
        assertTrue(PullRequestRefresh.shouldRefresh(idle.copy(lastFetchAt = null), Reason.Focus, 1))
        assertFalse(PullRequestRefresh.shouldRefresh(idle.copy(inFlight = true), Reason.Manual, 1))
        assertFalse(PullRequestRefresh.shouldRefresh(idle.copy(visible = false), Reason.Manual, 1))
        assertTrue(PullRequestRefresh.shouldRefresh(idle, Reason.Manual, 1))
        assertTrue(PullRequestRefresh.shouldRefresh(idle.copy(stale = true), Reason.Interval, 1))
        assertFalse(PullRequestRefresh.shouldRefresh(idle, Reason.Focus, 59_999))
        assertTrue(PullRequestRefresh.shouldRefresh(idle, Reason.Focus, 60_000))
        assertFalse(PullRequestRefresh.shouldRefresh(idle, Reason.Open, 299_999))
        assertTrue(PullRequestRefresh.shouldRefresh(idle, Reason.Interval, 300_000))
        assertEquals(0L, PullRequestRefresh.nextDelay(null, 5))
        assertEquals(299_000L, PullRequestRefresh.nextDelay(0, 1_000))
        assertEquals(0L, PullRequestRefresh.nextDelay(0, 400_000))
    }

    private fun data(vararg prs: PrSummary) =
        PrListData(prs = prs.toList(), sources = emptyList(), fetchedAt = 0, hidden = emptyList(), hiddenRepos = emptyList())

    private fun merged(number: Long) = open(number).copy(state = "merged", mergedAt = now - 60_000)

    private fun open(number: Long) = PrSummary(
        ref = PrRef("github", "geoiq", "switchboard", number),
        title = "PR $number",
        url = "",
        author = PrPerson("tejas", "tejas", null),
        state = "open",
        draft = false,
        sourceBranch = "b$number",
        targetBranch = "main",
        headFromFork = false,
        createdAt = 0,
        updatedAt = now - 60_000,
        mergedAt = null,
        additions = null,
        deletions = null,
        changedFiles = null,
        unresolvedConversations = 0,
        mergeConflicts = false,
        conflictedFiles = emptyList(),
        checks = ChecksRollup("success", 1, 1, 0, 0),
        reviewers = emptyList(),
        approvals = PrApprovals(0, null),
        viewer = PrViewer(isAuthor = true, isRequestedReviewer = false, hasReviewed = false, hasCommented = false),
        projectPaths = emptyList(),
    )
}
