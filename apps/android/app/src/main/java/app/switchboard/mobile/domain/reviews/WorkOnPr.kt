package app.switchboard.mobile.domain.reviews

import app.switchboard.mobile.domain.remote.AcpAgents
import app.switchboard.mobile.domain.remote.NewSessionDecisions
import app.switchboard.mobile.domain.remote.WorktreeExistingBranch
import app.switchboard.mobile.domain.thread.PrLinkRows
import java.io.Serializable
import java.util.Locale

/** The backend creates worktrees at all (the new-session worktree path). */
const val WORKTREE_CREATION_CAPABILITY = "worktree_creation_v1"

/**
 * Where "Start a chat" on a PR goes: a worktree on the PR's branch when the
 * backend can check an existing branch out and the PR's head can be fetched,
 * else a plain chat in the project's own checkout.
 */
data class WorkOnPrPlan(
    val projectPath: String,
    val projectName: String,
    /** Null: a plain chat in the parent checkout, and the pill asks the agent to check the PR out. */
    val existingBranch: WorktreeExistingBranch?,
) {
    val place: WorkOnPrPlace get() = if (existingBranch != null) WorkOnPrPlace.Worktree else WorkOnPrPlace.Checkout
}

/**
 * What the new-session screen needs to start a "Work on PR" chat, kept to
 * plain values so the navigation stack can save it.
 */
data class WorkOnPrIntent(
    val host: String,
    val owner: String,
    val name: String,
    val number: Long,
    val title: String,
    val sourceBranch: String,
    /** The existing branch to check out in a worktree; null starts in the parent checkout. */
    val branchName: String?,
    val fetchRef: String?,
    val worktreePillLabel: String,
    val worktreePillContent: String,
    val checkoutPillLabel: String,
    val checkoutPillContent: String,
) : Serializable {
    val ref: PrRef get() = PrRef(host, owner, name, number)

    val existingBranch: WorktreeExistingBranch?
        get() = branchName?.let { branch ->
            WorktreeExistingBranch(
                name = branch,
                fetch = fetchRef?.let { WorktreeExistingBranch.Fetch(ref = it, repo = WorktreeExistingBranch.Repo(host, owner, name)) },
            )
        }

    /** The pill for where the chat actually started: a worktree only when one was made. */
    fun pill(inWorktree: Boolean): PhoneReviewPill = if (inWorktree) {
        PhoneReviewPill(worktreePillLabel, worktreePillContent)
    } else {
        PhoneReviewPill(checkoutPillLabel, checkoutPillContent)
    }
}

object WorkOnPr {
    /** The composer draft a "Work on PR" chat opens with, for the user to send. */
    const val DRAFT = "Work on this pull request."
    const val NO_PROJECT = "No project on this machine covers this repository"

    /** null when no project on this machine covers the PR's repository. */
    fun plan(pr: PrSummary, capabilities: Set<String>): WorkOnPrPlan? {
        val projectPath = pr.projectPaths.firstOrNull() ?: return null
        val canCheckOut = WORK_ON_PR_CAPABILITY in capabilities && WORKTREE_CREATION_CAPABILITY in capabilities
        return WorkOnPrPlan(
            projectPath = projectPath,
            projectName = projectName(projectPath),
            existingBranch = if (canCheckOut) PhonePullRequests.workOnPrCheckout(pr) else null,
        )
    }

    fun intent(detail: PrDetail, plan: WorkOnPrPlan): WorkOnPrIntent {
        val pr = detail.summary
        val worktree = PhonePullRequests.workOnPrPill(detail, WorkOnPrPlace.Worktree)
        val checkout = PhonePullRequests.workOnPrPill(detail, WorkOnPrPlace.Checkout)
        return WorkOnPrIntent(
            host = pr.ref.host,
            owner = pr.ref.owner,
            name = pr.ref.name,
            number = pr.ref.number,
            title = pr.title,
            sourceBranch = pr.sourceBranch,
            branchName = plan.existingBranch?.name,
            fetchRef = plan.existingBranch?.fetch?.ref,
            worktreePillLabel = worktree.label,
            worktreePillContent = worktree.content,
            checkoutPillLabel = checkout.label,
            checkoutPillContent = checkout.content,
        )
    }

    /** The "Start a chat" row's subtitle. */
    fun newChatSubtitle(plan: WorkOnPrPlan?): String = when {
        plan == null -> NO_PROJECT
        plan.existingBranch != null -> "In a worktree of ${plan.projectName} on the PR's branch."
        else -> "In ${plan.projectName}. The agent checks out the PR first."
    }

    fun projectName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

    fun agentLabel(agentType: String): String =
        NewSessionDecisions.providers.firstOrNull { it.agentType == agentType }?.label
            ?: AcpAgents.label(agentType)
            ?: agentType

    /** A linked chat row's second line: "Claude Code · opened by the agent". */
    fun linkedChatSubtitle(chat: PrLinkChat): String =
        "${agentLabel(chat.agentType)} · ${PrLinkRows.sourceLabel(chat.linkSource).lowercase(Locale.ROOT)}"
}
