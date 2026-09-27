/**
 * Which buttons a pull request write card shows, which one is primary, and
 * what each sends back. Pure, so the rules are tested without React.
 */
import { checkReplyText, type HostWriteCard, type HostWriteResponse, type HostWriteReview } from '@shared/agent-host-writes'
import { checkCommentText, reviewVerdictProblem } from '@shared/agent-pr-review'
import { REVIEW_EVENT_LABEL, type ReviewEvent } from '@shared/pull-request-writes'
import { PR_HOST_LABEL } from '@shared/pull-requests'

export interface HostWriteButton {
  id: 'deny' | 'post' | 'post-resolve' | 'resolve' | 'rerun' | 'comment' | ReviewEvent
  label: string
  primary: boolean
  decision: 'approve' | 'deny'
  /** A draft review's buttons: the verdict each one submits. */
  verdict?: ReviewEvent
}

/** The order a review's verdict buttons appear in, mildest first. */
const VERDICT_ORDER: readonly ReviewEvent[] = ['comment', 'request_changes', 'approve']

export function hostWriteButtons(card: HostWriteCard): HostWriteButton[] {
  const deny: HostWriteButton = { id: 'deny', label: 'Deny', primary: false, decision: 'deny' }
  if (card.action === 'resolve') return [deny, { id: 'resolve', label: 'Resolve', primary: true, decision: 'approve' }]
  if (card.action === 'rerun') return [deny, { id: 'rerun', label: 'Re-run', primary: true, decision: 'approve' }]
  if (card.action === 'comment') return [deny, { id: 'comment', label: 'Post comment', primary: true, decision: 'approve' }]
  if (card.action === 'review') {
    // No verdict is primary: the user picks one, the agent never suggests it.
    const offered = card.review?.verdicts ?? []
    return [deny, ...VERDICT_ORDER.filter((v) => offered.includes(v)).map((v) => ({ id: v, label: REVIEW_EVENT_LABEL[v], primary: false, decision: 'approve' as const, verdict: v }))]
  }
  const resolveFirst = card.suggestResolve === true
  return [
    deny,
    { id: 'post', label: 'Post only', primary: !resolveFirst, decision: 'approve' },
    { id: 'post-resolve', label: 'Post and resolve', primary: resolveFirst, decision: 'approve' },
  ]
}

/** A draft review as the user is editing it in the card. */
export interface ReviewDraftState {
  summary: string
  comments: Array<{ id: string; text: string; removed: boolean }>
}

export function initialReviewDraft(review: HostWriteReview | undefined): ReviewDraftState {
  return {
    summary: review?.summary ?? '',
    comments: (review?.comments ?? []).map((c) => ({ id: c.id, text: c.text, removed: false })),
  }
}

const keptComments = (draft: ReviewDraftState) => draft.comments.filter((c) => !c.removed)

/** What an approval sends back. `text` is the card's textarea as the user left it; `draft` the review as the user left it. */
export function hostWriteResponse(card: HostWriteCard, button: HostWriteButton, text: string, draft: ReviewDraftState): HostWriteResponse {
  if (card.action === 'comment') return { text }
  if (card.action === 'review') {
    if (!button.verdict) return {}
    return { verdict: button.verdict, summary: draft.summary, comments: keptComments(draft).map((c) => ({ id: c.id, text: c.text })) }
  }
  if (card.action !== 'reply') return {}
  return { text, resolve: button.id === 'post-resolve' }
}

/** Why this verdict cannot be submitted with the draft as it stands, or null. The rule the backend applies again. */
export function reviewButtonProblem(card: HostWriteCard, verdict: ReviewEvent, draft: ReviewDraftState): string | null {
  if (!card.review) return 'This card has no review.'
  return reviewVerdictProblem(card.host, card.review, verdict, draft.summary, keptComments(draft))
}

/** Null when the reply or comment may be posted, else why not. The same rule the backend applies. */
export function replyTextProblem(card: HostWriteCard, text: string): string | null {
  if (card.action === 'comment') {
    const comment = checkCommentText(text)
    return comment.ok ? null : comment.message
  }
  if (card.action !== 'reply') return null
  const check = checkReplyText(text)
  return check.ok ? null : check.message
}

/** "Bitbucket · ssg-bot-v2 #612 · sync/worker.py:88". */
export function hostWriteContext(card: HostWriteCard): string {
  return [PR_HOST_LABEL[card.host], card.prLabel, card.location].filter(Boolean).join(' · ')
}
