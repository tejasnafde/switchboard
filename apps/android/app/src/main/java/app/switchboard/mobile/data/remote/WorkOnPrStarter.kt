package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.thread.PendingReviewPills
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.reviews.PhoneReviewPill
import app.switchboard.mobile.domain.reviews.WorkOnPr
import app.switchboard.mobile.domain.reviews.WorkOnPrIntent

/**
 * The end of "Work on PR > Start a chat": once the new chat exists, link the
 * PR to it (`pull-requests:link`, recorded as manual), leave the review pill
 * pending in its composer and prefill the draft for the user to send. The
 * pill names the worktree only when the chat actually started in one (a
 * failed worktree that fell back to the project asks for a checkout).
 */
class WorkOnPrStarter(
    private val connectionId: String,
    private val remote: ReviewsRemote,
    private val pills: PendingReviewPills,
    private val saveDraft: (ComposerDraft) -> Unit,
    private val log: (String) -> Unit = {},
) {
    fun onStarted(started: NewSessionStarted, intent: WorkOnPrIntent): PhoneReviewPill {
        val key = ComposerDraftKey(connectionId, started.threadId)
        val pill = intent.pill(inWorktree = started.worktreePath != null)
        pills.set(key, pill)
        saveDraft(ComposerDraft(key, text = WorkOnPr.DRAFT))
        remote.link(started.threadId, intent.ref) { response ->
            when (val outcome = response.outcome) {
                is RemoteOutcome.Failure -> log("pull-requests:link failed: ${outcome.message}")
                is RemoteOutcome.Success -> if (!outcome.value.ok) {
                    log("pull-requests:link refused: ${outcome.value.message}")
                }
            }
        }
        return pill
    }
}
