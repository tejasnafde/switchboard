/**
 * An agent's pull request write card as a phone answers it: the text as the
 * agent drafted it, one action-named button (or, for a review, one button per
 * verdict the card offers), and Deny. The phone does not edit; the desktop
 * card does. Pure, so the Expo app and the tests share one rule set, and the
 * native Android app ports it (`HostWritePhoneCard.kt`).
 */
import type { HostWriteCard, HostWriteResponse } from './agent-host-writes'
import { reviewFromResponse, reviewVerdictProblem } from './agent-pr-review'
import { reviewerLabel } from './agent-pr-reviewers'
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
 * review needs a verdict the card offered, and the review it asks for must be
 * one the host takes (GitHub's request changes needs a summary, no empty
 * comment, the size limits); refusing here, rather than after the card closed,
 * leaves it open so the user can pick again.
 */
export function hostWriteApprovalProblem(card: HostWriteCard, response: HostWriteResponse): string | null {
  if (card.action !== 'review') return null
  const verdict = response.verdict
  if (!verdict) return 'Pick Comment, Request changes or Approve to submit this review.'
  const review = card.review
  if (!review?.verdicts.includes(verdict)) return `${REVIEW_EVENT_LABEL[verdict]} is not offered on this review.`
  const checked = reviewFromResponse(card.host, review, response)
  return checked.ok ? null : checked.message
}

/**
 * What an approval from a device without the admin scope carries to the
 * broker: the choice (resolve, verdict, quiet), never replacement content. A phone
 * approves the draft its card showed; only the desktop edits.
 */
export function approvalChoiceOnly(response: HostWriteResponse): HostWriteResponse {
  return {
    ...(response.resolve !== undefined ? { resolve: response.resolve } : {}),
    ...(response.verdict !== undefined ? { verdict: response.verdict } : {}),
    ...(response.shown !== undefined ? { shown: response.shown } : {}),
    ...(response.quiet ? { quiet: true } : {}),
  }
}

/** Why a phone's approval without the digest of the draft it showed is refused. */
export const HOST_WRITE_SHOWN_REQUIRED = 'Update the Switchboard app to approve this here, or approve it on the desktop.'

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
    if (c.reviewers !== undefined) {
      if (!Array.isArray(c.reviewers) || !c.reviewers.every((r) => r && typeof r.login === 'string' && typeof r.displayName === 'string')) return null
      // One line each, so the approval (which requests all of them) shows every one.
      add('Reviewers', c.reviewers.map(reviewerLabel).join('\n'))
    }
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

/**
 * A fingerprint of one card as a phone showed it, which the phone sends as
 * `shown` with its approval and the broker recomputes from its own card. It
 * binds the request id, the target (host, repository, PR number; for a create,
 * the source and target branches), the action and exactly what
 * `hostWritePreview` shows (a create's reviewers included), so the same text on another PR or another card
 * does not match. An app that rendered a shortened detail (every build before
 * this one) sends none and is refused. It is not a secret: it proves which
 * draft was rendered, not who rendered it; the device scope does that.
 *
 * FNV-1a 64 over the UTF-16 code units (low byte first) of those fields
 * joined by NUL, so the Android port (`HostWriteCards.shownDigest`) computes
 * it without a crypto library. Null when the card has no preview or no target.
 */
export function hostWriteShownDigest(requestId: string, card: HostWriteCard): string | null {
  const preview = hostWritePreview(card)
  const target = card.target
  if (!preview || !target || typeof target.repository !== 'string' || !(target.number === null || typeof target.number === 'number')) return null
  const input = [
    SHOWN_DIGEST_VERSION, requestId, card.host, target.repository, target.number === null ? '' : String(target.number),
    card.create?.sourceBranch ?? '', card.create?.targetBranch ?? '', card.action,
    ...preview.sections.flatMap((s) => [s.label, s.text]),
  ].join('\u0000')
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i)
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit & 0xff)) * FNV_PRIME)
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit >>> 8)) * FNV_PRIME)
  }
  return hash.toString(16).padStart(16, '0')
}

const SHOWN_DIGEST_VERSION = 'sb-shown-2'
const FNV_OFFSET = BigInt('0xcbf29ce484222325')
const FNV_PRIME = BigInt('0x100000001b3')
