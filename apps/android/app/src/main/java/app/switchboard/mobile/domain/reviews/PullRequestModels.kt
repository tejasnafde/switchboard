package app.switchboard.mobile.domain.reviews

import java.util.Locale

/**
 * Pull request review data as the backend sends it on the open
 * `pull-requests:*` channels. Ported from src/shared/pull-requests.ts and
 * src/shared/pull-request-links.ts; a field the host cannot supply is null.
 * Hosts stay strings (`github`, `bitbucket`) so a newer backend's host does
 * not fail the whole list.
 */
data class RepoRef(
    val host: String,
    val owner: String,
    val name: String,
) {
    /** `repoKey`: case-insensitive on both hosts. */
    val key: String get() = "$host:$owner/$name".lowercase(Locale.ROOT)
    val label: String get() = "$owner/$name"
}

data class PrRef(
    val host: String,
    val owner: String,
    val name: String,
    val number: Long,
) {
    val repo: RepoRef get() = RepoRef(host, owner, name)

    /** `prKey`. */
    val key: String get() = "${repo.key}#$number"
}

data class PrPerson(
    val login: String,
    val displayName: String,
    val avatarUrl: String?,
)

data class PrReviewer(
    val id: String?,
    val person: PrPerson,
    /** `approved` | `changes_requested` | `commented` | `dismissed` | `pending`. */
    val state: String,
    val requested: Boolean,
)

data class ChecksRollup(
    /** `success` | `failure` | `pending` | `none`. */
    val state: String,
    val total: Int,
    val passed: Int,
    val failed: Int,
    val pending: Int,
)

data class PrViewer(
    val isAuthor: Boolean,
    val isRequestedReviewer: Boolean,
    val hasReviewed: Boolean,
    val hasCommented: Boolean,
)

data class PrApprovals(
    val given: Int,
    val required: Int?,
)

data class PrCheck(
    val id: String,
    val name: String,
    /** `success` | `failure` | `pending` | `skipped` | `neutral`. */
    val state: String,
    val description: String?,
    val url: String?,
    val durationMs: Long?,
)

data class PrSummary(
    val ref: PrRef,
    val title: String,
    val url: String,
    val author: PrPerson,
    /** `open` | `merged` | `closed`. */
    val state: String,
    val draft: Boolean,
    val sourceBranch: String,
    val targetBranch: String,
    /** Absent from an older backend, which reads as not a fork. */
    val headFromFork: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val mergedAt: Long?,
    val additions: Long?,
    val deletions: Long?,
    val changedFiles: Long?,
    val unresolvedConversations: Int?,
    val mergeConflicts: Boolean?,
    val conflictedFiles: List<String>,
    val checks: ChecksRollup,
    val reviewers: List<PrReviewer>,
    val approvals: PrApprovals,
    val viewer: PrViewer,
    val projectPaths: List<String>,
)

/** `PrDetail`: the summary plus what the phone's detail screen reads. */
data class PrDetail(
    val summary: PrSummary,
    /** Markdown, HTML comments already stripped by the backend. */
    val description: String,
    val checkList: List<PrCheck>,
)

data class PrError(
    val kind: String,
    val host: String?,
    val message: String,
)

sealed interface PrResult<out T> {
    data class Ok<T>(val data: T) : PrResult<T>
    data class Failed(val error: PrError) : PrResult<Nothing>
}

data class PrSource(
    val repo: RepoRef,
    val projectPaths: List<String>,
    val error: PrError?,
)

data class PrListData(
    val prs: List<PrSummary>,
    val sources: List<PrSource>,
    val fetchedAt: Long,
    /** `prKey`s the user hid from Reviews. */
    val hidden: List<String>,
    /** Repositories hidden from Reviews; empty from an older backend. */
    val hiddenRepos: List<RepoRef>,
)

/** A chat a PR is linked to (`linked-chats`) or could be linked to (`linkable-chats`). */
data class PrLinkChat(
    /** Root conversation id. */
    val id: String,
    val familyIds: List<String>,
    val title: String,
    val agentType: String,
    val projectPath: String,
    val updatedAt: Long,
    val linkSource: String?,
)

/** `pull-requests:link` and `pull-requests:unhide-repos`: `{ ok, message? }`. */
data class PrActionResult(
    val ok: Boolean,
    val message: String?,
)
