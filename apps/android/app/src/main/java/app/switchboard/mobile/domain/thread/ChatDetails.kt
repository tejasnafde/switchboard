package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.RepoRef
import kotlin.math.floor

/**
 * The chat Details sheet: machine, branch, linked pull request, working-tree
 * changes and the usage bars. Port of the desktop's `chat-details-model.ts`,
 * `src/shared/usage-left.ts` and the iOS app's `lib/chat-details.ts`; keep
 * the rules and text in sync.
 */
const val DETAILS_SHEET_CAPABILITY = "details_sheet_v1"

enum class LeftTone { Neutral, Warning, Error }

/** How much of a usage limit is left, and how loudly to say so. */
object UsageLeft {
    /** 100 minus the used percent, clamped to 0..100 and rounded; null when the used percent is unknown. */
    fun percent(used: Double?): Int? {
        if (used == null || !used.isFinite()) return null
        return (100 - used).coerceIn(0.0, 100.0).roundHalfUp()
    }

    /** Error at 10 % left or less, warning at 20 % or less. */
    fun tone(left: Int?): LeftTone = when {
        left == null -> LeftTone.Neutral
        left <= 10 -> LeftTone.Error
        left <= 20 -> LeftTone.Warning
        else -> LeftTone.Neutral
    }

    /** `Math.round`: halves go up, where Kotlin's `roundToInt` goes to even. */
    private fun Double.roundHalfUp(): Int = floor(this + 0.5).toInt()
}

/** `git:current-branch` and `git:diff-stat` answers. */
sealed interface DetailsRead<out T> {
    data object Reading : DetailsRead<Nothing>
    data class Read<T>(val value: T) : DetailsRead<T>

    /** Not a repository, a missing folder or a failed call: the row shows None. */
    data object Failed : DetailsRead<Nothing>
}

/** A null name is a detached HEAD. */
data class BranchName(val name: String?)

data class DiffStat(val added: Long, val removed: Long)

data class DetailsValue(val text: String, val muted: Boolean = false)

sealed interface ChangesValue {
    data class Text(val value: DetailsValue) : ChangesValue
    data class Lines(val added: Long, val removed: Long) : ChangesValue
}

/** One part of the PR row's second line. A `bad` part reads in red. */
data class PrPart(val text: String, val bad: Boolean = false)

data class PrValue(val title: String, val detail: List<PrPart>)

data class UsageBar(
    val label: String,
    /** 0..100, the fill width; null when the limit cannot be read. */
    val used: Int?,
    val left: Int?,
    val tone: LeftTone,
    /** No number yet because the read is in flight (not Unavailable). */
    val pending: Boolean,
)

/** The usage limits the bars read: `provider-instances:usage`, weekly and 5-hour windows only. */
data class UsageLimits(val weeklyUsed: Double?, val sessionUsed: Double?)

object ChatDetails {
    private val PENDING = DetailsValue("…", muted = true)
    private val NONE = DetailsValue("None", muted = true)

    /** `defaultInstanceId`: a chat with no profile reads its agent's seed account. */
    fun defaultInstanceId(provider: String?): String =
        "${if (provider == null || provider == "claude") "claude-code" else provider}-default"

    fun branch(read: DetailsRead<BranchName>): DetailsValue = when (read) {
        DetailsRead.Reading -> PENDING
        DetailsRead.Failed -> NONE
        is DetailsRead.Read -> read.value.name?.let(::DetailsValue) ?: DetailsValue("Detached HEAD")
    }

    fun changes(read: DetailsRead<DiffStat>): ChangesValue = when (read) {
        DetailsRead.Reading -> ChangesValue.Text(PENDING)
        DetailsRead.Failed -> ChangesValue.Text(NONE)
        is DetailsRead.Read -> if (read.value.added == 0L && read.value.removed == 0L) {
            ChangesValue.Text(DetailsValue("No changes", muted = true))
        } else {
            ChangesValue.Lines(read.value.added, read.value.removed)
        }
    }

    private class Row(val link: PrLink, val pr: PrSummary?, val state: String?)

    /** `linkHeaderState`: the link's stored state when read after the Reviews list, else the list's. */
    private fun row(link: PrLink, list: PrListData?): Row {
        val key = RepoRef(link.ref.host, link.ref.owner, link.ref.name).key + "#${link.ref.number}"
        val pr = list?.prs?.firstOrNull { it.ref.key == key }
        val listState = pr?.state
        val state = if (link.state != null && (listState == null || (link.stateAt ?: 0) > (list?.fetchedAt ?: 0))) {
            link.state
        } else {
            listState ?: link.state
        }
        return Row(link, pr, state)
    }

    private fun checks(row: Row): PrPart? {
        if (row.state != "open") return row.state?.let(::PrPart)
        val checks = row.pr?.checks ?: return PrPart("open")
        return when (checks.state) {
            "failure" -> PrPart("${checks.failed} ${if (checks.failed == 1) "check" else "checks"} failed", bad = true)
            "pending" -> PrPart("checks running")
            "success" -> PrPart("checks passed")
            else -> PrPart("no checks")
        }
    }

    /**
     * The first open linked PR, else the newest (created time when the Reviews
     * list has it, else link time, then the higher number); null when none is linked.
     */
    fun pr(links: List<PrLink>, list: PrListData?): PrValue? {
        val row = links.map { row(it, list) }
            .sortedWith(
                compareByDescending<Row> { it.state == "open" }
                    .thenByDescending { it.pr?.createdAt ?: it.link.linkedAt }
                    .thenByDescending { it.link.ref.number },
            )
            .firstOrNull() ?: return null
        return PrValue(
            title = row.pr?.title ?: "${row.link.ref.owner}/${row.link.ref.name}",
            detail = listOfNotNull(PrPart("#${row.link.ref.number}"), checks(row)),
        )
    }

    private fun bar(label: String, used: Double?, reading: Boolean = false): UsageBar {
        val left = UsageLeft.percent(used)
        return UsageBar(label, left?.let { 100 - it }, left, UsageLeft.tone(left), pending = left == null && reading)
    }

    /** [usage] is null while the read is in flight or after it failed ([reading] tells them apart). */
    fun usageBars(usage: UsageLimits?, reading: Boolean, contextUsed: Double?): List<UsageBar> {
        val pending = reading && usage == null
        return listOf(
            bar("Weekly", usage?.weeklyUsed, pending),
            bar("5-hour session", usage?.sessionUsed, pending),
            bar("Context", contextUsed),
        )
    }

    /** "Weekly, 42 percent left", or "Weekly, unavailable". */
    fun barDescription(bar: UsageBar): String = when {
        bar.left != null -> "${bar.label}, ${bar.left} percent left"
        bar.pending -> "${bar.label}, reading"
        else -> "${bar.label}, unavailable"
    }
}
