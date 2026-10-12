package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.reviews.PhonePrFilters
import app.switchboard.mobile.domain.reviews.PhonePrShow
import app.switchboard.mobile.domain.reviews.PrActionResult
import app.switchboard.mobile.domain.reviews.PrDetail
import app.switchboard.mobile.domain.reviews.PrError
import app.switchboard.mobile.domain.reviews.PrLinkChat
import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrResult
import app.switchboard.mobile.domain.reviews.PullRequestRefresh
import app.switchboard.mobile.domain.reviews.RepoRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewsCoordinatorTest {
    private val remote = RecordingReviewsRemote()
    private var now = 1_000_000L
    private val saved = mutableListOf<PhonePrFilters>()

    private fun coordinator() = ReviewsCoordinator(
        connectionId = "machine",
        generation = 3,
        remote = remote,
        clock = { now },
        initialFilters = PhonePrFilters(),
        saveFilters = { saved += it },
    ).also { it.setVisible(true) }

    @Test
    fun readsOnOpenThenFollowsTheRefreshRule() {
        val reviews = coordinator()
        assertTrue(reviews.refresh(PullRequestRefresh.Reason.Open))
        assertFalse("one read at a time", reviews.refresh(PullRequestRefresh.Reason.Focus))
        remote.lists.single()(ok(list(fetchedAt = 1)))
        now += 30_000
        assertFalse("focus within a minute does nothing", reviews.refresh(PullRequestRefresh.Reason.Focus))
        assertFalse(reviews.refresh(PullRequestRefresh.Reason.Interval))
        assertTrue("manual always reads", reviews.refresh(PullRequestRefresh.Reason.Manual))
        now += PullRequestRefresh.INTERVAL_MS
        remote.lists.last()(ok(list(fetchedAt = 2)))
        assertTrue(reviews.refresh(PullRequestRefresh.Reason.Interval))
    }

    @Test
    fun aHiddenScreenDoesNotRead() {
        val reviews = coordinator()
        reviews.setVisible(false)
        assertFalse(reviews.refresh(PullRequestRefresh.Reason.Open))
        assertTrue(remote.lists.isEmpty())
    }

    @Test
    fun aLateAnswerFromASupersededReadIsDropped() {
        val reviews = coordinator()
        reviews.refresh(PullRequestRefresh.Reason.Open)
        reviews.refresh(PullRequestRefresh.Reason.Manual)
        val (first, second) = remote.lists
        second(ok(list(fetchedAt = 2)))
        first(ok(list(fetchedAt = 1)))
        assertEquals(2L, reviews.state.value.data?.fetchedAt)
    }

    @Test
    fun anAnswerFromAnOlderConnectionGenerationIsDropped() {
        val reviews = coordinator()
        reviews.refresh(PullRequestRefresh.Reason.Open)
        remote.lists.single()(RemoteResponse(RemoteRequestKey("machine", 2, "list"), RemoteOutcome.Success(PrResult.Ok(list(1)))))
        assertNull(reviews.state.value.data)
        assertTrue(reviews.state.value.loading)
    }

    @Test
    fun aFailedRefreshKeepsTheOlderListAndSaysWhy() {
        val reviews = coordinator()
        reviews.refresh(PullRequestRefresh.Reason.Open)
        remote.lists.single()(ok(list(fetchedAt = 1)))
        reviews.refresh(PullRequestRefresh.Reason.Manual)
        remote.lists.last()(
            RemoteResponse(
                RemoteRequestKey("machine", 3, "list"),
                RemoteOutcome.Success(PrResult.Failed(PrError("offline", null, "The desktop is offline"))),
            ),
        )
        assertEquals(1L, reviews.state.value.data?.fetchedAt)
        assertEquals("The desktop is offline", reviews.state.value.error)
        assertEquals(1_000_000L, reviews.state.value.lastSuccessAt)
    }

    @Test
    fun filtersAreSavedOnlyWhenTheyChange() {
        val reviews = coordinator()
        reviews.setFilters(PhonePrFilters())
        reviews.setFilters(PhonePrFilters(show = PhonePrShow.Mine))
        assertEquals(listOf(PhonePrFilters(show = PhonePrShow.Mine)), saved)
    }

    @Test
    fun showingHiddenRepositoriesUnhidesThemAndReadsAgain() {
        val reviews = coordinator()
        reviews.refresh(PullRequestRefresh.Reason.Open)
        val hidden = listOf(RepoRef("github", "geoiq", "old"))
        remote.lists.single()(ok(list(fetchedAt = 1, hiddenRepos = hidden)))
        reviews.unhideRepos()
        assertEquals(hidden, remote.unhides.single().first)
        remote.unhides.single().second(RemoteResponse(RemoteRequestKey("machine", 3, "unhide"), RemoteOutcome.Success(PrActionResult(true, null))))
        assertEquals(2, remote.lists.size)
        assertFalse(reviews.state.value.unhiding)
    }

    private fun list(fetchedAt: Long, hiddenRepos: List<RepoRef> = emptyList()) =
        PrListData(prs = emptyList(), sources = emptyList(), fetchedAt = fetchedAt, hidden = emptyList(), hiddenRepos = hiddenRepos)

    private fun ok(data: PrListData) =
        RemoteResponse(RemoteRequestKey("machine", 3, "list"), RemoteOutcome.Success<PrResult<PrListData>>(PrResult.Ok(data)))
}

class PullRequestDetailCoordinatorTest {
    @Test
    fun aRetryDropsTheEarlierDetailAnswer() {
        val remote = RecordingReviewsRemote()
        val ref = PrRef("github", "geoiq", "switchboard", 1)
        val detail = PullRequestDetailCoordinator("machine", 3, ref, remote)
        detail.load()
        detail.load()
        remote.details[1](RemoteResponse(RemoteRequestKey("machine", 3, "detail"), RemoteOutcome.Failure("timeout")))
        remote.details[0](RemoteResponse(RemoteRequestKey("machine", 3, "detail"), RemoteOutcome.Failure("stale")))
        assertEquals("timeout", detail.state.value.error)
        assertFalse(detail.state.value.loading)
    }
}

internal class RecordingReviewsRemote : ReviewsRemote {
    val lists = mutableListOf<(RemoteResponse<PrResult<PrListData>>) -> Unit>()
    val unhides = mutableListOf<Pair<List<RepoRef>, (RemoteResponse<PrActionResult>) -> Unit>>()
    val details = mutableListOf<(RemoteResponse<PrResult<PrDetail>>) -> Unit>()
    val links = mutableListOf<Pair<Pair<String, PrRef>, (RemoteResponse<PrActionResult>) -> Unit>>()

    override fun list(callback: (RemoteResponse<PrResult<PrListData>>) -> Unit) {
        lists += callback
    }

    override fun unhideRepos(repos: List<RepoRef>, callback: (RemoteResponse<PrActionResult>) -> Unit) {
        unhides += repos to callback
    }

    override fun detail(ref: PrRef, callback: (RemoteResponse<PrResult<PrDetail>>) -> Unit) {
        details += callback
    }

    override fun linkedChats(ref: PrRef, callback: (RemoteResponse<List<PrLinkChat>>) -> Unit) = Unit

    override fun linkableChats(ref: PrRef, callback: (RemoteResponse<List<PrLinkChat>>) -> Unit) = Unit

    override fun link(threadId: String, ref: PrRef, callback: (RemoteResponse<PrActionResult>) -> Unit) {
        links += (threadId to ref) to callback
    }
}
