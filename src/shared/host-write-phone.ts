/**
 * An agent's pull request write card as a phone answers it: the text as the
 * agent drafted it, one action-named button (or, for a review, one button per
 * verdict the card offers), and Deny. The phone does not edit; the desktop
 * card does. Pure, so the Expo app and the tests share one rule set, and the
 * native Android app ports it (`HostWritePhoneCard.kt`).
 */
import type { HostWriteCard, HostWriteResponse } from './agent-host-writes'
import { reviewVerdictProblem } from './agent-pr-review'
import { lineLocation, REVIEW_EVENT_LABEL, type ReviewEvent } from './pull-request-writes'

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

/**
 * What an approval from a device without the admin scope carries to the
 * broker: the choice (resolve, verdict), never replacement content. A phone
 * approves the draft its card showed; only the desktop edits.
 */
export function approvalChoiceOnly(response: HostWriteResponse): HostWriteResponse {
  return {
    ...(response.resolve !== undefined ? { resolve: response.resolve } : {}),
    ...(response.verdict !== undefined ? { verdict: response.verdict } : {}),
  }
}

/** One labelled block of a phone card: a title, a reply, one review comment. */
export interface HostWritePreviewSection {
  label: string
  text: string
}

export interface HostWritePreview {
  /** Everything the approval posts, in full, plus the reviewer comment a reply answers. */
  sections: HostWritePreviewSection[]
  /** Too long to show at once: the card starts collapsed and approval waits until it is expanded. */
  long: boolean
}

/** A draft longer than this starts collapsed on a phone. */
export const HOST_WRITE_PREVIEW_COLLAPSED_LINES = 12
const PREVIEW_COLLAPSED_CHARS = 800

/**
 * The card's whole content for a phone to show before it approves, or null
 * when the payload lacks something the approval would post (an older or
 * different backend), so the phone cannot show all of it and sends the user
 * to the desktop. Never `hostWriteDetail`: that caps long comments.
 */
export function hostWritePreview(card: HostWriteCard): HostWritePreview | null {
  const sections: HostWritePreviewSection[] = []
  const add = (label: string, text: unknown): boolean => {
    if (typeof text !== 'string') return false
    if (text) sections.push({ label, text })
    return true
  }
  const quote = card.quote
  if (quote && typeof quote.author === 'string') add(`${quote.author} wrote`, quote.body)
  if (card.action === 'create') {
    const c = card.create
    if (!c || typeof c.title !== 'string' || !c.title) return null
    add('Branches', `${c.repoLabel}: ${c.sourceBranch} -> ${c.targetBranch}`)
    add('Title', c.title)
    if (!add('Description', c.description ?? '')) return null
  } else if (card.action === 'reply' || card.action === 'comment') {
    if (typeof card.replyText !== 'string' || !card.replyText) return null
    add(card.action === 'reply' ? 'Reply' : 'Comment', card.replyText)
  } else if (card.action === 'review') {
    const r = card.review
    if (!r || !Array.isArray(r.comments) || !add('Summary', r.summary ?? '')) return null
    for (const c of r.comments) {
      if (!c || typeof c.path !== 'string' || typeof c.line !== 'number' || typeof c.text !== 'string') return null
      add(lineLocation(c), c.text)
    }
  } else if (card.action === 'rerun') {
    add('Check', card.checkName ?? 'a failed check')
  } else if (card.action !== 'resolve') {
    return null
  }
  const lines = sections.reduce((n, s) => n + 1 + s.text.split('\n').length, 0)
  const chars = sections.reduce((n, s) => n + s.label.length + s.text.length, 0)
  return { sections, long: lines > HOST_WRITE_PREVIEW_COLLAPSED_LINES || chars > PREVIEW_COLLAPSED_CHARS }
}
