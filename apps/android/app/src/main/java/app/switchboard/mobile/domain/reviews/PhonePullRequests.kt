package app.switchboard.mobile.domain.reviews

import app.switchboard.mobile.domain.remote.WorktreeExistingBranch
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.util.Locale
import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * The phone's Reviews tab rules, ported from src/shared/pull-request-phone.ts,
 * `prRowStatus`/`groupPullRequests`/`filterPullRequests` in
 * src/shared/pull-request-groups.ts and the check and conflict items of
 * src/shared/review-context.ts. Keep them in sync: both suites run
 * tests/fixtures/phone-pr-cases.json. Read-only: a phone calls no
 * `PullRequestWriteChannels` channel.
 */

const val WORK_ON_PR_CAPABILITY = "worktree_existing_branch_v1"

enum class PrGroupId(val wire: String, val label: String) {
    NeedsYou("needs-you", "Needs you"),
    Ready("ready", "Ready to merge"),
    Yours("yours", "Your pull requests"),
    Reviewing("reviewing", "Reviewing"),
    Merged("merged", "Merged this week"),
}

/** The row's one glyph; the renderer maps each to a shape and a tone. */
enum class PrRowIcon(val wire: String) {
    Conflict("conflict"),
    Failed("failed"),
    Review("review"),
    Conversation("conversation"),
    Running("running"),
    Waiting("waiting"),
    Ready("ready"),
    Merged("merged"),
    Draft("draft"),
}

data class PrRowStatus(
    val group: PrGroupId,
    val icon: PrRowIcon,
    /** Short phrase after the repo and number; empty when the group says it all. */
    val phrase: String,
)

data class PrRow(val pr: PrSummary, val status: PrRowStatus)

enum class PhonePrShow(val wire: String, val label: String) {
    All("all", "All"),
    NeedsYou("needs-you", "Needs you"),
    Mine("mine", "Mine"),
    Reviewing("reviewing", "Reviewing"),
}

enum class PhonePrChecks(val wire: String, val label: String) {
    Any("any", "Any"),
    Failing("failing", "Failing"),
    Running("running", "Running"),
    Passing("passing", "Passing"),
}

enum class PhonePrGroupBy(val wire: String, val label: String) {
    Status("status", "Status"),
    Repository("repository", "Repository"),
}

data class PhonePrFilters(
    val show: PhonePrShow = PhonePrShow.All,
    val groupBy: PhonePrGroupBy = PhonePrGroupBy.Status,
    val checks: PhonePrChecks = PhonePrChecks.Any,
    /** `repoKey`s left out of the list. */
    val excludedRepos: List<String> = emptyList(),
    val showDrafts: Boolean = true,
    val showHidden: Boolean = false,
)

data class PhonePrSection(
    val key: String,
    val title: String,
    val rows: List<PrRow>,
)

data class PhonePrRepo(val key: String, val label: String)

data class PhonePrHostError(
    val host: String,
    val title: String,
    val message: String,
)

enum class PhonePrTone(val wire: String) {
    Failure("failure"),
    Pending("pending"),
    Success("success"),
    Dim("dim"),
}

data class PhonePrStatusLine(val text: String, val tone: PhonePrTone)

/**
 * Where a "Work on PR" pill lands: a worktree on the PR's branch, the plain
 * project checkout (the agent checks the PR out first), or an existing chat
 * it is attached to (no instruction line).
 */
enum class WorkOnPrPlace { Worktree, Checkout, Attached }

data class PhoneReviewPill(
    val label: String,
    /** What the agent reads in place of the pill. */
    val content: String,
)

data class ReviewPillTurn(
    val displayBody: String,
    val providerText: String,
    /** pill id to label; the kind is always `review`. */
    val pillsMeta: Map<String, String>,
)

object PhonePullRequests {
    private val GROUP_ORDER = PrGroupId.entries
    private const val MERGED_WINDOW_MS = 7L * 24 * 60 * 60 * 1000
    val DEFAULT_FILTERS = PhonePrFilters()

    /** Checks shown before "+ N more passed" when the card is expanded. */
    const val PHONE_CHECKS_SHOWN = 6

    /** [canWrite]: the desktop granted this phone `pr-write`, so it posts replies, comments and reviews itself. */
    fun mergeOnDesktopNote(host: String, canWrite: Boolean = false): String =
        if (canWrite) {
            "Merges, closes, reviewers and re-runs stay on the desktop app. " +
                "Replies, comments and reviews from this phone post as you on ${hostLabel(host)}."
        } else {
            "Reviews, comments and merges post as you on ${hostLabel(host)}, so they stay on the desktop app."
        }
    const val RERUN_ON_DESKTOP_NOTE = "Re-run failed jobs on the desktop."

    fun hostLabel(host: String): String = when (host) {
        "github" -> "GitHub"
        "bitbucket" -> "Bitbucket"
        else -> host
    }

    // ─── Row status and groups (pull-request-groups.ts) ──────────────

    private fun plural(n: Long, one: String, many: String = "${one}s"): String = "$n ${if (n == 1L) one else many}"

    private fun approvalsPhrase(pr: PrSummary): String {
        val (given, required) = pr.approvals
        if (required != null && required > 0) return "$given of $required approvals"
        return if (given > 0) plural(given.toLong(), "approval") else "waiting for review"
    }

    private fun viewerPhrase(pr: PrSummary): String = when {
        pr.viewer.hasReviewed -> "you reviewed"
        pr.viewer.hasCommented -> "you commented"
        else -> approvalsPhrase(pr)
    }

    /** `mergeBlockers(pr).length === 0` in pull-requests.ts. */
    private fun hasMergeBlockers(pr: PrSummary): Boolean {
        if (pr.state != "open") return false
        val (given, required) = pr.approvals
        return pr.draft ||
            pr.mergeConflicts == true ||
            pr.checks.state == "failure" ||
            pr.checks.state == "pending" ||
            (pr.unresolvedConversations ?: 0) > 0 ||
            pr.reviewers.any { it.state == "changes_requested" } ||
            (required != null && given < required)
    }

    /** null when the PR is not listed at all (closed, or merged over a week ago). */
    fun rowStatus(pr: PrSummary, now: Long): PrRowStatus? {
        if (pr.state == "merged") {
            val mergedAt = pr.mergedAt ?: return null
            if (now - mergedAt > MERGED_WINDOW_MS) return null
            return PrRowStatus(PrGroupId.Merged, PrRowIcon.Merged, "")
        }
        if (pr.state != "open") return null

        if (!pr.viewer.isAuthor) {
            if (pr.viewer.isRequestedReviewer) return PrRowStatus(PrGroupId.NeedsYou, PrRowIcon.Review, "your review")
            if (pr.mergeConflicts == true) return PrRowStatus(PrGroupId.Reviewing, PrRowIcon.Conflict, "merge conflicts")
            if (pr.checks.state == "pending") return PrRowStatus(PrGroupId.Reviewing, PrRowIcon.Running, "checks running")
            return PrRowStatus(PrGroupId.Reviewing, PrRowIcon.Waiting, viewerPhrase(pr))
        }

        if (pr.draft) return PrRowStatus(PrGroupId.Yours, PrRowIcon.Draft, "draft")
        if (pr.mergeConflicts == true) return PrRowStatus(PrGroupId.NeedsYou, PrRowIcon.Conflict, "merge conflicts")
        if (pr.checks.state == "failure") return PrRowStatus(PrGroupId.NeedsYou, PrRowIcon.Failed, "build failed")
        val open = pr.unresolvedConversations ?: 0
        if (open > 0) {
            return PrRowStatus(PrGroupId.NeedsYou, PrRowIcon.Conversation, plural(open.toLong(), "open conversation"))
        }
        if (pr.reviewers.any { it.state == "changes_requested" }) {
            return PrRowStatus(PrGroupId.NeedsYou, PrRowIcon.Conversation, "changes requested")
        }
        if (pr.checks.state == "pending") return PrRowStatus(PrGroupId.Yours, PrRowIcon.Running, "checks running")
        val (given, required) = pr.approvals
        val approved = if (required != null) given >= required else given > 0
        if (approved && !hasMergeBlockers(pr)) return PrRowStatus(PrGroupId.Ready, PrRowIcon.Ready, "")
        return PrRowStatus(PrGroupId.Yours, PrRowIcon.Waiting, approvalsPhrase(pr))
    }

    /** Groups in display order, empty ones dropped; newest update first, merged by merge time. */
    fun groups(prs: List<PrSummary>, now: Long): List<Pair<PrGroupId, List<PrRow>>> {
        val buckets = linkedMapOf<PrGroupId, MutableList<PrRow>>()
        prs.forEach { pr ->
            val status = rowStatus(pr, now) ?: return@forEach
            buckets.getOrPut(status.group) { mutableListOf() } += PrRow(pr, status)
        }
        return GROUP_ORDER.mapNotNull { id ->
            val rows = buckets[id]?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val at = { pr: PrSummary -> if (id == PrGroupId.Merged) pr.mergedAt ?: 0 else pr.updatedAt }
            id to rows.sortedByDescending { at(it.pr) }
        }
    }

    /** Case-insensitive filter over title, repo, number, author and branch; a leading # is ignored. */
    fun textFilter(prs: List<PrSummary>, query: String): List<PrSummary> {
        val q = query.trim().lowercase(Locale.ROOT).removePrefix("#")
        if (q.isEmpty()) return prs
        return prs.filter { pr ->
            listOf(
                pr.title,
                pr.ref.name,
                pr.ref.owner,
                pr.ref.number.toString(),
                pr.author.login,
                pr.author.displayName,
                pr.sourceBranch,
            ).any { it.lowercase(Locale.ROOT).contains(q) }
        }
    }

    // ─── Filters (pull-request-phone.ts) ─────────────────────────────

    /** The filter button carries a dot when the sheet holds anything but the defaults. */
    fun filtersActive(f: PhonePrFilters): Boolean =
        f.checks != PhonePrChecks.Any || f.excludedRepos.isNotEmpty() || !f.showDrafts || f.showHidden

    private fun shows(pr: PrSummary, show: PhonePrShow, status: PrRowStatus): Boolean = when (show) {
        PhonePrShow.All -> true
        PhonePrShow.NeedsYou -> status.group == PrGroupId.NeedsYou
        PhonePrShow.Mine -> pr.viewer.isAuthor
        PhonePrShow.Reviewing -> !pr.viewer.isAuthor
    }

    private fun checksMatch(pr: PrSummary, checks: PhonePrChecks): Boolean = when (checks) {
        PhonePrChecks.Any -> true
        PhonePrChecks.Failing -> pr.checks.state == "failure"
        PhonePrChecks.Running -> pr.checks.state == "pending"
        PhonePrChecks.Passing -> pr.checks.state == "success"
    }

    /** The listed PRs after the text filter and the sheet. Unlisted PRs never pass. */
    fun filter(prs: List<PrSummary>, hidden: List<String>, f: PhonePrFilters, query: String, now: Long): List<PrSummary> {
        val hiddenKeys = hidden.toSet()
        val excluded = f.excludedRepos.toSet()
        return textFilter(prs, query).filter { pr ->
            val status = rowStatus(pr, now) ?: return@filter false
            if (!f.showHidden && pr.ref.key in hiddenKeys) return@filter false
            if (!f.showDrafts && pr.draft) return@filter false
            if (pr.ref.repo.key in excluded) return@filter false
            shows(pr, f.show, status) && checksMatch(pr, f.checks)
        }
    }

    /** The Reviews tab badge and the "Needs you" chip: listed, not hidden, in Needs you. */
    fun needsYouCount(prs: List<PrSummary>, hidden: List<String>, now: Long): Int {
        val hiddenKeys = hidden.toSet()
        return prs.count { pr -> pr.ref.key !in hiddenKeys && rowStatus(pr, now)?.group == PrGroupId.NeedsYou }
    }

    /** Sections in display order: the desktop's status groups, or one per repository in status order. */
    fun sections(prs: List<PrSummary>, groupBy: PhonePrGroupBy, now: Long): List<PhonePrSection> {
        val groups = groups(prs, now)
        if (groupBy == PhonePrGroupBy.Status) {
            return groups.map { (id, rows) -> PhonePrSection(id.wire, id.label, rows) }
        }
        val sections = linkedMapOf<String, MutableList<PrRow>>()
        val titles = mutableMapOf<String, String>()
        groups.flatMap { it.second }.forEach { row ->
            val key = row.pr.ref.repo.key
            titles.putIfAbsent(key, row.pr.ref.repo.label)
            sections.getOrPut(key) { mutableListOf() } += row
        }
        return sections.map { (key, rows) -> PhonePrSection(key, titles.getValue(key), rows) }
    }

    /** The repositories the filter sheet lists: every one with a listed PR, by name. */
    fun repos(prs: List<PrSummary>): List<PhonePrRepo> {
        val repos = linkedMapOf<String, String>()
        prs.forEach { repos[it.ref.repo.key] = it.ref.repo.label }
        return repos.map { (key, label) -> PhonePrRepo(key, label) }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
    }

    fun toggleExcludedRepo(f: PhonePrFilters, key: String): PhonePrFilters =
        f.copy(excludedRepos = if (key in f.excludedRepos) f.excludedRepos - key else f.excludedRepos + key)

    /** "now", "12m", "3h", "2d". */
    fun ageLabel(at: Long, now: Long): String {
        val minutes = (now - at).coerceAtLeast(0) / 60_000
        if (minutes < 1) return "now"
        if (minutes < 60) return "${minutes}m"
        val hours = minutes / 60
        if (hours < 24) return "${hours}h"
        return "${hours / 24}d"
    }

    /** The header subtitle after the machine name: "8 open", "nothing open", "showing Bitbucket only". */
    fun subtitle(listed: Int, failedHosts: List<String>, readHosts: List<String>): String {
        val working = readHosts.filter { it !in failedHosts }
        if (failedHosts.isNotEmpty() && working.size == 1) return "showing ${hostLabel(working.single())} only"
        return if (listed == 0) "nothing open" else "$listed open"
    }

    /** One card per host whose every repository failed with the same host-wide problem. */
    fun hostErrors(sources: List<PrSource>): List<PhonePrHostError> = listOf("github", "bitbucket").mapNotNull { host ->
        val mine = sources.filter { it.repo.host == host }
        val first = mine.firstOrNull()?.error ?: return@mapNotNull null
        if (first.kind == "not_found" || first.kind == "forbidden") return@mapNotNull null
        if (!mine.all { it.error?.kind == first.kind }) return@mapNotNull null
        PhonePrHostError(host, "Couldn't read ${hostLabel(host)}", first.message)
    }

    /** The hosts the list read at all, for the subtitle. */
    fun hosts(sources: List<PrSource>): List<String> = sources.map { it.repo.host }.distinct()

    // ─── Detail ──────────────────────────────────────────────────────

    fun checksStatus(c: ChecksRollup): PhonePrStatusLine = when (c.state) {
        "failure" -> PhonePrStatusLine("${c.failed} of ${c.total} failed", PhonePrTone.Failure)
        "pending" -> PhonePrStatusLine("${c.pending} of ${c.total} running", PhonePrTone.Pending)
        "success" -> PhonePrStatusLine(if (c.total == 1) "Passed" else "All ${c.total} passed", PhonePrTone.Success)
        else -> PhonePrStatusLine("None reported", PhonePrTone.Dim)
    }

    fun reviewsStatus(pr: PrSummary): PhonePrStatusLine {
        val changes = pr.reviewers.any { it.state == "changes_requested" }
        val (given, required) = pr.approvals
        val approvals = when {
            required != null && required > 0 -> "$given of $required approvals"
            given > 0 -> plural(given.toLong(), "approval")
            else -> ""
        }
        val waiting = pr.reviewers.any { it.requested && it.state == "pending" }
        val second = approvals.ifEmpty { if (changes) "" else if (waiting) "Waiting for review" else "No reviews" }
        val text = listOf(if (changes) "Changes requested" else "", second).filter { it.isNotEmpty() }.joinToString(" · ")
        val approved = if (required != null) given >= required && given > 0 else given > 0
        val tone = when {
            changes -> PhonePrTone.Pending
            approved -> PhonePrTone.Success
            else -> PhonePrTone.Dim
        }
        return PhonePrStatusLine(text, tone)
    }

    fun conversationsStatus(pr: PrSummary): PhonePrStatusLine {
        val open = pr.unresolvedConversations ?: return PhonePrStatusLine("Not reported", PhonePrTone.Dim)
        return if (open > 0) PhonePrStatusLine("$open open", PhonePrTone.Pending) else PhonePrStatusLine("None open", PhonePrTone.Success)
    }

    fun conflictsStatus(pr: PrSummary): PhonePrStatusLine {
        val conflicts = pr.mergeConflicts ?: return PhonePrStatusLine("Not checked yet", PhonePrTone.Dim)
        if (!conflicts) return PhonePrStatusLine("None with ${pr.targetBranch}", PhonePrTone.Success)
        val files = pr.conflictedFiles.size
        return PhonePrStatusLine(
            if (files > 0) plural(files.toLong(), "file") else "With ${pr.targetBranch}",
            PhonePrTone.Failure,
        )
    }

    private fun checkOrder(state: String): Int = when (state) {
        "failure" -> 0
        "pending" -> 1
        "success" -> 2
        "neutral" -> 3
        "skipped" -> 4
        else -> 5
    }

    /** Failures first, then running, then the rest, each in the host's order (a stable sort). */
    fun orderedChecks(checks: List<PrCheck>): List<PrCheck> = checks.sortedBy { checkOrder(it.state) }

    /** "4m 12s", "48s", "1h 02m". */
    fun checkDuration(ms: Long): String {
        val seconds = floor(ms / 1000.0 + 0.5).toLong()
        if (seconds < 60) return "${seconds}s"
        val minutes = seconds / 60
        if (minutes < 60) return "${minutes}m ${(seconds % 60).toString().padStart(2, '0')}s"
        return "${minutes / 60}h ${(minutes % 60).toString().padStart(2, '0')}m"
    }

    /** The right side of a check row: "failed · 4m 12s", "running", "1m 05s", "skipped". */
    fun checkTrailing(check: PrCheck): String {
        val duration = check.durationMs?.let(::checkDuration).orEmpty()
        return when (check.state) {
            "failure" -> if (duration.isNotEmpty()) "failed · $duration" else "failed"
            "pending" -> "running"
            "skipped" -> "skipped"
            else -> duration
        }
    }

    /** "+ 8 more passed", or "+ 3 more" when they are not all passes; empty when none are hidden. */
    fun moreChecksLabel(hidden: List<PrCheck>): String {
        if (hidden.isEmpty()) return ""
        return if (hidden.all { it.state == "success" }) "+ ${hidden.size} more passed" else "+ ${hidden.size} more"
    }

    /** "+184 -37 in 6 files", or empty when the host did not say. */
    fun diffStatLabel(pr: PrSummary): String {
        val additions = pr.additions ?: return ""
        val deletions = pr.deletions ?: return ""
        val files = pr.changedFiles?.let { " in ${plural(it, "file")}" }.orEmpty()
        return "+$additions -$deletions$files"
    }

    // ─── Work on PR ──────────────────────────────────────────────────

    /**
     * The existing-branch checkout for a PR's head: a GitHub fork through
     * `refs/pull/<n>/head` into `pr-<n>`, a Bitbucket fork not at all (null).
     */
    fun workOnPrCheckout(pr: PrSummary): WorktreeExistingBranch? {
        val repo = WorktreeExistingBranch.Repo(pr.ref.host, pr.ref.owner, pr.ref.name)
        if (pr.headFromFork) {
            if (pr.ref.host != "github") return null
            return WorktreeExistingBranch(
                name = "pr-${pr.ref.number}",
                fetch = WorktreeExistingBranch.Fetch(ref = "refs/pull/${pr.ref.number}/head", repo = repo),
            )
        }
        return WorktreeExistingBranch(
            name = pr.sourceBranch,
            fetch = WorktreeExistingBranch.Fetch(ref = pr.sourceBranch, repo = repo),
        )
    }

    /** The shell command an agent runs to check the PR out itself. */
    fun prCheckoutCommand(pr: PrSummary): String =
        if (pr.ref.host == "github") "gh pr checkout ${pr.ref.number}" else "bbpr ${pr.ref.number}"

    /** The review pill a "Work on PR" chat starts with: the PR, its conflicts and failed checks. */
    fun workOnPrPill(detail: PrDetail, place: WorkOnPrPlace): PhoneReviewPill {
        val pr = detail.summary
        val items = buildList {
            if (pr.mergeConflicts == true) add(ReviewContext.conflictsItem(pr))
            detail.checkList.filter { it.state == "failure" }.forEach { add(ReviewContext.checkItem(it)) }
        }
        val ctx = ReviewContext(pr.ref, pr.title, pr.url, items)
        val expansion = ReviewContext.expand(ctx)
        val where = when (place) {
            WorkOnPrPlace.Worktree -> "This chat runs in a worktree on the pull request's branch (${pr.sourceBranch})."
            WorkOnPrPlace.Checkout ->
                "Before anything else, check out the pull request: run `${prCheckoutCommand(pr)}` in this project, " +
                    "and stop and say so if that fails."
            WorkOnPrPlace.Attached -> ""
        }
        return PhoneReviewPill(ReviewContext.label(ctx), if (where.isNotEmpty()) "$expansion\n\n$where" else expansion)
    }

    /** A send that carries a review pill: the chip before the typed text, its content in the provider text. */
    fun reviewPillTurn(text: String, pill: PhoneReviewPill, pillId: String): ReviewPillTurn {
        val body = text.trim()
        return ReviewPillTurn(
            displayBody = if (body.isNotEmpty()) "[[pill:$pillId]] $body" else "[[pill:$pillId]]",
            providerText = if (body.isNotEmpty()) "${pill.content}\n\n$body" else pill.content,
            pillsMeta = mapOf(pillId to pill.label),
        )
    }

    /** "Ask the agent about the failures": the failed checks only; null when none failed. */
    fun failedChecksPill(detail: PrDetail): PhoneReviewPill? {
        val failed = detail.checkList.filter { it.state == "failure" }
        if (failed.isEmpty()) return null
        val pr = detail.summary
        val ctx = ReviewContext(pr.ref, pr.title, pr.url, failed.map(ReviewContext::checkItem))
        return PhoneReviewPill(ReviewContext.label(ctx), ReviewContext.expand(ctx))
    }

    /** `review-<base36 time>-<random>`, the desktop's pill id shape. */
    fun newPillId(nowMs: Long, random: java.util.Random = java.util.Random()): String =
        "review-${nowMs.toString(36)}-${random.nextInt(36 * 36 * 36 * 36).toString(36)}"

    // ─── Persistence ─────────────────────────────────────────────────

    fun filtersKey(connectionId: String): String = "reviews.filters.$connectionId"

    fun encodeFilters(f: PhonePrFilters): String = JsonCodec.encode(
        JsonObject(
            linkedMapOf(
                "show" to JsonString(f.show.wire),
                "groupBy" to JsonString(f.groupBy.wire),
                "checks" to JsonString(f.checks.wire),
                "excludedRepos" to JsonArray(f.excludedRepos.map(::JsonString)),
                "showDrafts" to JsonBoolean(f.showDrafts),
                "showHidden" to JsonBoolean(f.showHidden),
            ),
        ),
    )

    /** A stored value from another version reads field by field; anything unknown keeps its default. */
    fun decodeFilters(value: String?): PhonePrFilters {
        val raw = value?.let { runCatching { JsonCodec.parse(it) }.getOrNull() } as? JsonObject ?: return DEFAULT_FILTERS
        fun str(key: String) = (raw.values[key] as? JsonString)?.value
        fun bool(key: String) = (raw.values[key] as? JsonBoolean)?.value
        return PhonePrFilters(
            show = PhonePrShow.entries.firstOrNull { it.wire == str("show") } ?: DEFAULT_FILTERS.show,
            groupBy = PhonePrGroupBy.entries.firstOrNull { it.wire == str("groupBy") } ?: DEFAULT_FILTERS.groupBy,
            checks = PhonePrChecks.entries.firstOrNull { it.wire == str("checks") } ?: DEFAULT_FILTERS.checks,
            excludedRepos = (raw.values["excludedRepos"] as? JsonArray)?.values
                ?.mapNotNull { (it as? JsonString)?.value }
                .orEmpty(),
            showDrafts = bool("showDrafts") ?: DEFAULT_FILTERS.showDrafts,
            showHidden = bool("showHidden") ?: DEFAULT_FILTERS.showHidden,
        )
    }
}

/**
 * The check and conflict items of src/shared/review-context.ts: one review
 * pill whose label the chip shows and whose expansion the agent reads.
 */
data class ReviewContext(
    val pr: PrRef,
    val title: String,
    val url: String,
    val items: List<Item>,
) {
    sealed interface Item {
        data class Check(val name: String, val description: String?, val url: String?) : Item
        data class Conflicts(val base: String, val head: String, val files: List<String>) : Item
    }

    companion object {
        const val MAX_BYTES = 12 * 1024
        const val LABEL_MAX_CHARS = 120

        fun checkItem(c: PrCheck): Item = Item.Check(c.name, c.description, c.url)

        fun conflictsItem(pr: PrSummary): Item = Item.Conflicts(pr.targetBranch, pr.sourceBranch, pr.conflictedFiles)

        fun conflictInstruction(base: String, head: String): String =
            "Merge the base branch ($base) into this branch ($head) and resolve the conflicts, then push. " +
                "Never rebase or force-push."

        private fun plural(n: Int, one: String): String = "$n $one${if (n == 1) "" else "s"}"

        private fun where(item: Item, short: Boolean = false): String = when (item) {
            is Item.Check -> item.name
            is Item.Conflicts -> if (item.files.isNotEmpty()) {
                item.files.joinToString(", ") { if (short) it.substringAfterLast('/') else it }
            } else {
                "${item.head} into ${item.base}"
            }
        }

        /** One compact line for the pill: "2 failed checks · #1482 · lint, e2e". */
        fun label(ctx: ReviewContext): String {
            val checks = ctx.items.count { it is Item.Check }
            val conflicts = ctx.items.firstOrNull { it is Item.Conflicts } as Item.Conflicts?
            val parts = listOfNotNull(
                conflicts?.let { "Merge conflicts with ${it.base}" },
                checks.takeIf { it > 0 }?.let { plural(it, "failed check") },
            )
            val head = "${parts.joinToString(", ").ifEmpty { "Review context" }} · #${ctx.pr.number}"
            val places = ctx.items.joinToString(", ") { where(it, short = true) }
            val label = if (places.isNotEmpty()) "$head · $places" else head
            return if (label.length > LABEL_MAX_CHARS) "${label.substring(0, LABEL_MAX_CHARS - 1)}…" else label
        }

        private fun block(item: Item, index: Int): String {
            val n = "[${index + 1}]"
            return when (item) {
                is Item.Check -> listOfNotNull(
                    "$n Failed check: ${item.name}",
                    item.description?.takeIf { it.isNotEmpty() }?.let { "Description: $it" },
                    item.url?.takeIf { it.isNotEmpty() }?.let { "Log: $it" },
                ).joinToString("\n")
                is Item.Conflicts -> listOf(
                    "$n Merge conflicts: ${item.head} conflicts with ${item.base}.",
                    if (item.files.isNotEmpty()) {
                        "Conflicted files: ${item.files.joinToString(", ")}"
                    } else {
                        "The host does not name the conflicted files; find them with git."
                    },
                    conflictInstruction(item.base, item.head),
                ).joinToString("\n")
            }
        }

        private fun bytes(text: String): Int = text.toByteArray(Charsets.UTF_8).size

        /** Cut [text] to at most [max] UTF-8 bytes without splitting a character. */
        private fun cutToBytes(text: String, max: Int): String {
            if (bytes(text) <= max) return text
            val out = StringBuilder()
            var used = 0
            var index = 0
            while (index < text.length) {
                val codePoint = text.codePointAt(index)
                val ch = String(Character.toChars(codePoint))
                val size = bytes(ch)
                if (used + size > max) break
                out.append(ch)
                used += size
                index += Character.charCount(codePoint)
            }
            return out.toString()
        }

        /** The text the agent receives in place of the pill, under [maxBytes]. */
        fun expand(ctx: ReviewContext, maxBytes: Int = MAX_BYTES): String {
            val pr = ctx.pr
            val header = listOf(
                "Review context from ${PhonePullRequests.hostLabel(pr.host)} ${pr.owner}/${pr.name} #${pr.number}: ${ctx.title}",
                ctx.url,
                "Read-only context from the pull request. Nothing has been posted to the host.",
            ).joinToString("\n")
            val reserve = 400
            var out = header
            val omitted = mutableListOf<Item>()
            var cut = false
            val kib = (maxBytes / 1024.0).roundToLong()
            ctx.items.forEachIndexed { index, item ->
                if (omitted.isNotEmpty()) {
                    omitted += item
                    return@forEachIndexed
                }
                val text = "\n\n${block(item, index)}"
                if (bytes(out) + bytes(text) <= maxBytes - reserve) {
                    out += text
                } else if (index == 0) {
                    out += "${cutToBytes(text, maxBytes - reserve - bytes(out))}\n(cut short)"
                    cut = true
                } else {
                    omitted += item
                }
            }
            if (omitted.isNotEmpty()) {
                val names = omitted.take(8).joinToString(", ") { where(it) }
                val more = if (omitted.size > 8) " and ${omitted.size - 8} more" else ""
                val note = "\n\n(${plural(omitted.size, "more item")} left out to stay under $kib KiB: $names$more. " +
                    "Read them on the host.)"
                out += cutToBytes(note, reserve)
            } else if (cut) {
                out += "\n(The item was longer than $kib KiB. Read the rest on the host.)"
            }
            return cutToBytes(out, maxBytes)
        }
    }
}

/** src/shared/pull-request-refresh.ts: when the Reviews list re-reads. */
object PullRequestRefresh {
    const val INTERVAL_MS = 5 * 60_000L
    const val FOCUS_MIN_GAP_MS = 60_000L

    enum class Reason { Open, Focus, Interval, Manual }

    data class State(
        /** When the last read started, null before the first. */
        val lastFetchAt: Long?,
        val inFlight: Boolean,
        val visible: Boolean,
        val stale: Boolean = false,
    )

    fun shouldRefresh(state: State, reason: Reason, now: Long): Boolean {
        if (state.inFlight || !state.visible) return false
        val last = state.lastFetchAt ?: return true
        if (state.stale || reason == Reason.Manual) return true
        val age = now - last
        return when (reason) {
            Reason.Open, Reason.Interval -> age >= INTERVAL_MS
            Reason.Focus -> age >= FOCUS_MIN_GAP_MS
            Reason.Manual -> true
        }
    }

    /** Delay until the next interval read, from when the last one started. */
    fun nextDelay(lastFetchAt: Long?, now: Long): Long =
        if (lastFetchAt == null) 0 else (lastFetchAt + INTERVAL_MS - now).coerceAtLeast(0)
}
