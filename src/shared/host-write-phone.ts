/**
 * An agent's pull request write card as a phone answers it: the text as the
 * agent drafted it, one action-named button (or, for a review, one button per
 * verdict the card offers), and Deny. The phone does not edit; the desktop
 * card does. Pure, so the Expo app and the tests share one rule set, and the
 * native Android app ports it (`HostWritePhoneCard.kt`).
 */
import type { HostWriteCard, HostWriteResponse } from './agent-host-writes'
import { reviewVerdictProblem } from './agent-pr-review'
import { REVIEW_EVENT_LABEL, type ReviewEvent } from './pull-request-writes'

/**
 * The backend capability that says a chat-scoped device may approve these
 * cards. A backend without it refuses the approval, so a phone offers Deny only.
 */
export const HOST_WRITE_PHONE_APPROVAL_CAPABILITY = 'agent_host_write_phone_approval_v1'

export interface PhoneHostWriteButton {
  id: 'create' | 'post' | 'post-resolve' | 'resolve' | 'rerun' | 'comment' | ReviewEvent
  label: string
  /** The one button a tap should land on. A review has none: the verdict is the user's to pick. */
  primary: boolean
  /** Sent as the 4th argument of `provider:respond-to-request`. */
  response: HostWriteResponse
  /** Why this button cannot go as drafted (edit on the desktop), or null. */
  problem: string | null
}

/** The order a review's verdict buttons appear in, mildest first, as on the desktop. */
const VERDICT_ORDER: readonly ReviewEvent[] = ['comment', 'request_changes', 'approve']

export function phoneHostWriteButtons(card: HostWriteCard): PhoneHostWriteButton[] {
  const one = (id: PhoneHostWriteButton['id'], label: string): PhoneHostWriteButton[] => [{ id, label, primary: true, response: {}, problem: null }]
  if (card.action === 'create') return one('create', card.create?.draft ? 'Open draft' : 'Open pull request')
  if (card.action === 'resolve') return one('resolve', 'Resolve')
  if (card.action === 'rerun') return one('rerun', 'Re-run')
  if (card.action === 'comment') return one('comment', 'Post comment')
  if (card.action === 'review') {
    const review = card.review
    if (!review) return []
    return VERDICT_ORDER.filter((v) => review.verdicts.includes(v)).map((verdict) => ({
      id: verdict,
      label: REVIEW_EVENT_LABEL[verdict],
      primary: false,
      response: { verdict },
      problem: reviewVerdictProblem(card.host, review, verdict, review.summary, review.comments),
    }))
  }
  const resolveFirst = card.suggestResolve === true
  return [
    { id: 'post', label: 'Post reply', primary: !resolveFirst, response: { resolve: false }, problem: null },
    { id: 'post-resolve', label: 'Post and resolve', primary: resolveFirst, response: { resolve: true }, problem: null },
  ]
}

/**
 * Why the broker refuses this approval before it closes the card, or null. A
 * review needs a verdict the card offered; refusing here, rather than after
 * the card closed, leaves it open so the user can pick again.
 */
export function hostWriteApprovalProblem(card: HostWriteCard, response: HostWriteResponse): string | null {
  if (card.action !== 'review') return null
  const verdict = response.verdict
  if (!verdict) return 'Pick Comment, Request changes or Approve to submit this review.'
  if (!card.review?.verdicts.includes(verdict)) return `${REVIEW_EVENT_LABEL[verdict]} is not offered on this review.`
  return null
}
