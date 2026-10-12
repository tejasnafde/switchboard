package app.switchboard.mobile.ui.reviews

import app.switchboard.mobile.data.remote.ReviewsState
import app.switchboard.mobile.domain.reviews.PhonePrHostError
import app.switchboard.mobile.domain.reviews.PhonePrRepo
import app.switchboard.mobile.domain.reviews.PhonePrSection
import app.switchboard.mobile.domain.reviews.PhonePrShow
import app.switchboard.mobile.domain.reviews.PhonePrTone
import app.switchboard.mobile.domain.reviews.PhonePullRequests
import app.switchboard.mobile.domain.reviews.PrGroupId
import app.switchboard.mobile.domain.reviews.PrRowIcon
import app.switchboard.mobile.domain.reviews.PrRowStatus

sealed interface ReviewsBody {
    data object Loading : ReviewsBody
    data class Failure(val message: String) : ReviewsBody

    /** Nothing open passes the filters; [merged] rows from this week can still be shown. */
    data class NothingOpen(val merged: Int) : ReviewsBody

    data object NoMatch : ReviewsBody
    data class Sections(val sections: List<PhonePrSection>) : ReviewsBody
}

data class ReviewsPresentation(
    val subtitle: String,
    val needsYou: Int,
    val hostErrors: List<PhonePrHostError>,
    /** "Last read from the desktop 4 min ago" after a failed refresh with an older list shown. */
    val staleNote: String?,
    val hiddenReposLabel: String?,
    val body: ReviewsBody,
    val repos: List<PhonePrRepo>,
    val hiddenCount: Int,
    val filtersActive: Boolean,
)

object ReviewsPresenter {
    const val EMPTY_TITLE = "Nothing open that involves you"
    const val EMPTY_BODY = "Pull requests you authored, were asked to review, or commented on show here. " +
        "They are read through this desktop's GitHub and Bitbucket accounts."

    fun present(state: ReviewsState, connectionLabel: String, now: Long, showMerged: Boolean): ReviewsPresentation {
        val data = state.data
        val filters = state.filters
        if (data == null) {
            return ReviewsPresentation(
                subtitle = connectionLabel,
                needsYou = 0,
                hostErrors = emptyList(),
                staleNote = null,
                hiddenReposLabel = null,
                body = state.error?.let(ReviewsBody::Failure) ?: ReviewsBody.Loading,
                repos = emptyList(),
                hiddenCount = 0,
                filtersActive = PhonePullRequests.filtersActive(filters),
            )
        }
        val hostErrors = PhonePullRequests.hostErrors(data.sources)
        val listedOpen = data.prs.count { pr ->
            val status = PhonePullRequests.rowStatus(pr, now)
            status != null && status.group != PrGroupId.Merged && pr.ref.key !in data.hidden
        }
        val shown = PhonePullRequests.filter(data.prs, data.hidden, filters, state.query, now)
        val sections = PhonePullRequests.sections(shown, filters.groupBy, now)
        val rows = sections.flatMap { it.rows }
        val open = rows.count { it.status.group != PrGroupId.Merged }
        val merged = rows.size - open
        val body = when {
            open > 0 -> ReviewsBody.Sections(sections)
            state.query.isNotBlank() -> if (rows.isEmpty()) ReviewsBody.NoMatch else ReviewsBody.Sections(sections)
            showMerged && merged > 0 -> ReviewsBody.Sections(sections)
            else -> ReviewsBody.NothingOpen(merged)
        }
        val listedKeys = data.prs.filter { PhonePullRequests.rowStatus(it, now) != null }.map { it.ref.key }.toSet()
        return ReviewsPresentation(
            subtitle = "$connectionLabel · ${
                PhonePullRequests.subtitle(listedOpen, hostErrors.map { it.host }, PhonePullRequests.hosts(data.sources))
            }",
            needsYou = PhonePullRequests.needsYouCount(data.prs, data.hidden, now),
            hostErrors = hostErrors,
            staleNote = if (state.error != null) staleNote(state.lastSuccessAt, now) else null,
            hiddenReposLabel = data.hiddenRepos.size.takeIf { it > 0 }?.let {
                if (it == 1) "1 repository hidden" else "$it repositories hidden"
            },
            body = body,
            repos = PhonePullRequests.repos(data.prs.filter { PhonePullRequests.rowStatus(it, now) != null }),
            hiddenCount = data.hidden.count { it in listedKeys },
            filtersActive = PhonePullRequests.filtersActive(filters),
        )
    }

    fun staleNote(lastSuccessAt: Long?, now: Long): String? {
        val at = lastSuccessAt ?: return null
        val minutes = (now - at).coerceAtLeast(0) / 60_000
        return if (minutes < 1) "Last read from the desktop just now" else "Last read from the desktop $minutes min ago"
    }

    /** The "Needs you" chip carries the count, as the tab badge does. */
    fun chipLabel(show: PhonePrShow, needsYou: Int): String =
        if (show == PhonePrShow.NeedsYou && needsYou > 0) "${show.label} · $needsYou" else show.label

    /** The phrase after `owner/name #n`: failures and conflicts red, approvals green, running amber. */
    fun phraseTone(status: PrRowStatus): PhonePrTone = when {
        status.icon == PrRowIcon.Failed || status.icon == PrRowIcon.Conflict -> PhonePrTone.Failure
        status.icon == PrRowIcon.Running -> PhonePrTone.Pending
        status.phrase.contains("approval") -> PhonePrTone.Success
        else -> PhonePrTone.Dim
    }

    fun rowMeta(status: PrRowStatus, repo: String, number: Long): String =
        if (status.phrase.isEmpty()) "$repo #$number" else "$repo #$number · ${status.phrase}"
}
