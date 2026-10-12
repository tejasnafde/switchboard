package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.reviews.PhonePrFilters
import app.switchboard.mobile.domain.reviews.PrActionResult
import app.switchboard.mobile.domain.reviews.PrDetail
import app.switchboard.mobile.domain.reviews.PrLinkChat
import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrResult
import app.switchboard.mobile.domain.reviews.PullRequestRefresh
import app.switchboard.mobile.domain.reviews.RepoRef
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The open `pull-requests:*` reads a phone makes. No write channel is here, by design. */
interface ReviewsRemote {
    fun list(callback: (RemoteResponse<PrResult<PrListData>>) -> Unit)
    fun unhideRepos(repos: List<RepoRef>, callback: (RemoteResponse<PrActionResult>) -> Unit)
    fun detail(ref: PrRef, callback: (RemoteResponse<PrResult<PrDetail>>) -> Unit)
    fun linkedChats(ref: PrRef, callback: (RemoteResponse<List<PrLinkChat>>) -> Unit)
    fun linkableChats(ref: PrRef, callback: (RemoteResponse<List<PrLinkChat>>) -> Unit)
    fun link(threadId: String, ref: PrRef, callback: (RemoteResponse<PrActionResult>) -> Unit)
}

class SwitchboardReviewsRemote(private val client: SwitchboardRemoteClient) : ReviewsRemote {
    override fun list(callback: (RemoteResponse<PrResult<PrListData>>) -> Unit) =
        client.listPullRequests(callback).let { }

    override fun unhideRepos(repos: List<RepoRef>, callback: (RemoteResponse<PrActionResult>) -> Unit) =
        client.unhidePullRequestRepos(repos, callback).let { }

    override fun detail(ref: PrRef, callback: (RemoteResponse<PrResult<PrDetail>>) -> Unit) =
        client.pullRequestDetail(ref, callback).let { }

    override fun linkedChats(ref: PrRef, callback: (RemoteResponse<List<PrLinkChat>>) -> Unit) =
        client.pullRequestLinkedChats(ref, callback).let { }

    override fun linkableChats(ref: PrRef, callback: (RemoteResponse<List<PrLinkChat>>) -> Unit) =
        client.pullRequestLinkableChats(ref, callback).let { }

    override fun link(threadId: String, ref: PrRef, callback: (RemoteResponse<PrActionResult>) -> Unit) =
        client.linkPullRequest(threadId, ref, callback).let { }
}

data class ReviewsState(
    /** The last list read that answered; kept through a failed refresh. */
    val data: PrListData? = null,
    val loading: Boolean = false,
    /** Why the last read failed; null after a success. */
    val error: String? = null,
    /** Phone clock time of the last successful read. */
    val lastSuccessAt: Long? = null,
    val filters: PhonePrFilters = PhonePrFilters(),
    val query: String = "",
    val unhiding: Boolean = false,
    val unhideError: String? = null,
)

/**
 * One connection's Reviews list. Reads follow [PullRequestRefresh] (open,
 * focus, every 5 minutes while visible, manual), and a read that answers
 * after a newer one started, or on an older connection generation, is dropped.
 */
class ReviewsCoordinator(
    private val connectionId: String,
    private val generation: Long,
    private val remote: ReviewsRemote,
    private val clock: () -> Long,
    initialFilters: PhonePrFilters,
    private val saveFilters: (PhonePrFilters) -> Unit,
    private val log: (String) -> Unit = {},
) {
    private val mutableState = MutableStateFlow(ReviewsState(filters = initialFilters))
    val state: StateFlow<ReviewsState> = mutableState.asStateFlow()

    private var request = 0L
    private var lastFetchAt: Long? = null
    private var inFlight = false
    private var visible = false
    private var stale = false
    private var unhideRequest = 0L

    @Synchronized
    fun setVisible(value: Boolean) {
        visible = value
    }

    /** When the next interval read is due, from now. */
    @Synchronized
    fun nextRefreshDelay(): Long = PullRequestRefresh.nextDelay(lastFetchAt, clock())

    /** Starts a read when the refresh rule allows it; returns whether it did. */
    @Synchronized
    fun refresh(reason: PullRequestRefresh.Reason): Boolean {
        val now = clock()
        val manual = reason == PullRequestRefresh.Reason.Manual
        // A manual read supersedes one in flight rather than waiting on it.
        val gate = PullRequestRefresh.State(lastFetchAt, inFlight && !manual, visible || manual, stale)
        if (!PullRequestRefresh.shouldRefresh(gate, reason, now)) return false
        val id = ++request
        lastFetchAt = now
        inFlight = true
        stale = false
        mutableState.value = mutableState.value.copy(loading = true)
        remote.list { response -> accept(id, response) }
        return true
    }

    @Synchronized
    private fun accept(id: Long, response: RemoteResponse<PrResult<PrListData>>) {
        if (id != request || !current(response)) return
        inFlight = false
        val failure = when (val outcome = response.outcome) {
            is RemoteOutcome.Failure -> outcome.message
            is RemoteOutcome.Success -> when (val result = outcome.value) {
                is PrResult.Failed -> result.error.message
                is PrResult.Ok -> {
                    mutableState.value = mutableState.value.copy(
                        data = result.data,
                        loading = false,
                        error = null,
                        lastSuccessAt = clock(),
                    )
                    return
                }
            }
        }
        log("pull-requests:list failed: $failure")
        mutableState.value = mutableState.value.copy(loading = false, error = failure)
    }

    @Synchronized
    fun setFilters(filters: PhonePrFilters) {
        if (filters == mutableState.value.filters) return
        mutableState.value = mutableState.value.copy(filters = filters)
        saveFilters(filters)
    }

    @Synchronized
    fun setQuery(query: String) {
        mutableState.value = mutableState.value.copy(query = query)
    }

    /** "N repositories hidden · Show": unhides them on the desktop, then re-reads the list. */
    @Synchronized
    fun unhideRepos() {
        val repos = mutableState.value.data?.hiddenRepos.orEmpty()
        if (repos.isEmpty() || mutableState.value.unhiding) return
        val id = ++unhideRequest
        mutableState.value = mutableState.value.copy(unhiding = true, unhideError = null)
        remote.unhideRepos(repos) { response ->
            synchronized(this) {
                if (id != unhideRequest || !current(response)) return@unhideRepos
                val failure = when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> outcome.message
                    is RemoteOutcome.Success ->
                        if (outcome.value.ok) null else outcome.value.message ?: "Could not show the repositories"
                }
                if (failure != null) log("pull-requests:unhide-repos failed: $failure")
                mutableState.value = mutableState.value.copy(unhiding = false, unhideError = failure)
                if (failure == null) {
                    stale = true
                    refresh(PullRequestRefresh.Reason.Manual)
                }
            }
        }
    }

    private fun current(response: RemoteResponse<*>): Boolean =
        response.key.connectionId == connectionId && response.key.generation == generation
}

data class PullRequestDetailState(
    val detail: PrDetail? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val linkedChats: List<PrLinkChat> = emptyList(),
    /** null until asked for (the Attach and Ask pickers). */
    val linkableChats: List<PrLinkChat>? = null,
    val linkableError: String? = null,
)

/** One PR's detail and its chats; each read keeps only its newest answer. */
class PullRequestDetailCoordinator(
    private val connectionId: String,
    private val generation: Long,
    val ref: PrRef,
    private val remote: ReviewsRemote,
    private val log: (String) -> Unit = {},
) {
    private val mutableState = MutableStateFlow(PullRequestDetailState())
    val state: StateFlow<PullRequestDetailState> = mutableState.asStateFlow()
    private var detailRequest = 0L
    private var chatsRequest = 0L
    private var linkableRequest = 0L

    @Synchronized
    fun load() {
        val id = ++detailRequest
        mutableState.value = mutableState.value.copy(loading = true, error = null)
        remote.detail(ref) { response ->
            synchronized(this) {
                if (id != detailRequest || !current(response)) return@detail
                val failure = when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> outcome.message
                    is RemoteOutcome.Success -> when (val result = outcome.value) {
                        is PrResult.Failed -> result.error.message
                        is PrResult.Ok -> {
                            mutableState.value = mutableState.value.copy(detail = result.data, loading = false)
                            null
                        }
                    }
                }
                if (failure != null) {
                    log("pull-requests:detail failed: $failure")
                    mutableState.value = mutableState.value.copy(loading = false, error = failure)
                }
            }
        }
        loadLinkedChats()
    }

    @Synchronized
    fun loadLinkedChats() {
        val id = ++chatsRequest
        remote.linkedChats(ref) { response ->
            synchronized(this) {
                if (id != chatsRequest || !current(response)) return@linkedChats
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> mutableState.value = mutableState.value.copy(linkedChats = outcome.value)
                    is RemoteOutcome.Failure -> log("pull-requests:linked-chats failed: ${outcome.message}")
                }
            }
        }
    }

    @Synchronized
    fun loadLinkableChats() {
        val id = ++linkableRequest
        mutableState.value = mutableState.value.copy(linkableChats = null, linkableError = null)
        remote.linkableChats(ref) { response ->
            synchronized(this) {
                if (id != linkableRequest || !current(response)) return@linkableChats
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> mutableState.value = mutableState.value.copy(linkableChats = outcome.value)
                    is RemoteOutcome.Failure -> {
                        log("pull-requests:linkable-chats failed: ${outcome.message}")
                        mutableState.value = mutableState.value.copy(linkableChats = emptyList(), linkableError = outcome.message)
                    }
                }
            }
        }
    }

    private fun current(response: RemoteResponse<*>): Boolean =
        response.key.connectionId == connectionId && response.key.generation == generation
}
