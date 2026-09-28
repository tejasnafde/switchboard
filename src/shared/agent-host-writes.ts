/**
 * Pull request writes an AGENT asks for through the Switchboard MCP server
 * (open a pull request, reply to a review conversation, resolve one, re-run a
 * failed check, comment on a line, draft a review), and the approval card
 * each one shows before anything reaches a host.
 *
 * The card rides the ordinary `request.opened` / `request.closed` events with
 * a `hostWrite` payload, so a client that does not know the payload still
 * renders a plain approval from `detail`. The answer comes back on
 * `provider:respond-to-request` with an optional `HostWriteResponse`: the
 * text the user edited in the card is the text that gets posted.
 */
import type { DiffLineKind, PrHost } from './pull-requests'
import { lineLocation, type ReviewEvent } from './pull-request-writes'
import type { RuntimeMode } from './provider-events'

/** The last line of everything an agent posts, so a reader knows a person did not type it. */
export const VIA_SWITCHBOARD_MARKER = 'via Switchboard'

/** An agent reply is a short answer to a reviewer, not a report. The host's own cap is far higher. */
export const AGENT_REPLY_MAX_CHARS = 8_000

/** Writes one chat may ask for inside the window, approved or not. */
export const AGENT_WRITE_BUDGET = 10
export const AGENT_WRITE_WINDOW_MS = 10 * 60_000

/**
 * How long a card waits for an answer. An unanswered card is denied after
 * this, so an agent that timed out on its side can never post later.
 */
export const HOST_WRITE_APPROVAL_TTL_MS = 10 * 60_000

/** The most lines one agent comment may cover. A longer range is a file-level remark, not a line comment. */
export const AGENT_COMMENT_MAX_LINES = 200

/** A draft review holds at most this many inline comments; the human form allows more. */
export const AGENT_REVIEW_MAX_COMMENTS = 30
/** The summary and every comment of a draft review together, in UTF-8 bytes. */
export const AGENT_REVIEW_MAX_BYTES = 40 * 1024

export type HostWriteAction = 'create' | 'reply' | 'resolve' | 'rerun' | 'comment' | 'review'

/** A pull request the agent asks to open. The title and description are editable in the card. */
export interface HostWriteCreate {
  /** "acme/app". */
  repoLabel: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
  /** GitHub only. */
  draft: boolean
}

/** A diff line shown in the card around the line a comment lands on. */
export interface HostWriteDiffLine {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
  /** A line the comment covers. */
  target: boolean
}

export interface HostWriteReviewComment {
  /** Minted by the server ("c1", "c2"); the card answers with it. */
  id: string
  path: string
  side: 'new' | 'old'
  /** The last line the comment covers. */
  line: number
  /** The first line when it covers several. */
  startLine?: number
  text: string
  excerpt: HostWriteDiffLine[]
}

export interface HostWriteReview {
  summary: string
  comments: HostWriteReviewComment[]
  /**
   * The verdicts the card offers, from who the user is on this PR (an author
   * gets Comment only). Never a choice: the card pre-selects none of them.
   */
  verdicts: ReviewEvent[]
  /** Why only Comment is offered: the user wrote the PR, or it is not open. */
  commentOnly?: 'author' | 'closed'
}

export interface HostWriteCard {
  action: HostWriteAction
  /** "Codex", "Claude Code", "OpenCode": who asked. */
  agentLabel: string
  host: PrHost
  /** "ssg-bot-v2 #612", or the repository ("acme/app") for a pull request not opened yet. */
  prLabel: string
  url: string | null
  /** "sync/worker.py:88", or null for a conversation on the whole PR. */
  location: string | null
  /** The reviewer comment the reply answers, or the conversation being resolved. */
  quote: { author: string; body: string } | null
  /** The agent's draft; the card lets the user edit it. Reply and comment. */
  replyText?: string
  /** The diff around the line. Comment only. */
  excerpt?: HostWriteDiffLine[]
  /** Comment only, when it covers several lines. */
  lineRange?: { start: number; end: number }
  /** Review only. */
  review?: HostWriteReview
  /** The agent asked to resolve after replying, so "Post and resolve" is the primary button. */
  suggestResolve?: boolean
  /** Re-run only. */
  checkName?: string
  /** Create only. */
  create?: HostWriteCreate
  maxChars: number
}

/** What the card sends back with an approval. */
export interface HostWriteResponse {
  /** The reply or the comment as the user left it in the card. */
  text?: string
  /** "Post and resolve" (true) or "Post only" (false). Absent from a client that shows a plain approval, which runs what the agent asked. */
  resolve?: boolean
  /** Review: the verdict the user picked. A review approved without one posts nothing. */
  verdict?: ReviewEvent
  /** Review: the summary as the user left it. */
  summary?: string
  /** Review: the comments the user kept, by id, with their text as edited. A removed comment is absent. */
  comments?: Array<{ id: string; text: string }>
  /** Create: the title as the user left it. */
  title?: string
  /** Create: the description as the user left it. */
  description?: string
}

export type AgentToolGate = 'allow' | 'deny' | 'card'

/**
 * Posting as the user on GitHub or Bitbucket is not a local edit, so full
 * access does not waive the card: it is the one place a person sees the words
 * before they go out under their name. Plan mode refuses without a card,
 * because nothing enforces plan mode for an MCP tool except this server.
 */
export function hostWriteGate(mode: RuntimeMode): AgentToolGate {
  return mode === 'plan' ? 'deny' : 'card'
}

/**
 * Opening a pull request is the exception: the user asked for it, it merges
 * nothing, and closing it undoes it. So full access opens it without a card,
 * like any other action full access allows. Plan mode still refuses.
 */
export function createPullRequestGate(mode: RuntimeMode): AgentToolGate {
  return mode === 'full-access' ? 'allow' : hostWriteGate(mode)
}

/** `text` with exactly one marker line at the end, whatever the agent or the user already typed. */
export function withViaMarker(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim().replace(/^[_*]+|[_*]+$/g, '').toLowerCase() === VIA_SWITCHBOARD_MARKER.toLowerCase()) {
    lines.pop()
  }
  const body = lines.join('\n').replace(/\s+$/, '')
  return body ? `${body}\n\n${VIA_SWITCHBOARD_MARKER}` : VIA_SWITCHBOARD_MARKER
}

export type ReplyTextCheck = { ok: true; text: string } | { ok: false; message: string }

/** The same rule for the agent's draft and the user's edit. Trims; the marker is added later. */
export function checkReplyText(value: unknown): ReplyTextCheck {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: 'The reply is empty.' }
  const text = value.trim()
  if (text.length > AGENT_REPLY_MAX_CHARS) {
    return { ok: false, message: `The reply is ${text.length} characters; the limit is ${AGENT_REPLY_MAX_CHARS}. Say it shorter.` }
  }
  return { ok: true, text }
}

/** The approval as plain text: what a phone shows, and all an older client that does not render the card has. */
export function hostWriteDetail(card: HostWriteCard): string {
  const where = [card.prLabel, card.location].filter(Boolean).join(' · ')
  const lines: string[] = []
  if (card.action === 'create' && card.create) {
    const c = card.create
    lines.push(`Open a${c.draft ? ' draft' : ''} pull request on ${c.repoLabel}: ${c.sourceBranch} -> ${c.targetBranch}`, '', c.title)
    if (c.description) lines.push('', capDetail(c.description))
  }
  if (card.action === 'reply') lines.push(`Reply on ${where}${card.suggestResolve ? ', then resolve' : ''}`)
  if (card.action === 'resolve') lines.push(`Resolve the conversation on ${where}`)
  if (card.action === 'rerun') lines.push(`Re-run ${card.checkName ?? 'a failed check'} on ${card.prLabel}`)
  if (card.action === 'comment') lines.push(`Comment on ${where}`)
  if (card.action === 'review') lines.push(`Review ${card.prLabel} with ${card.review?.comments.length ?? 0} line comments`)
  if (card.quote) lines.push('', `${card.quote.author}: ${card.quote.body}`)
  if (card.replyText) lines.push('', card.replyText)
  if (card.review) {
    if (card.review.summary) lines.push('', card.review.summary)
    for (const c of card.review.comments) lines.push('', `${lineLocation(c)}: ${capDetail(c.text)}`)
  }
  return lines.join('\n')
}

const DETAIL_COMMENT_CHARS = 300

function capDetail(text: string): string {
  return text.length > DETAIL_COMMENT_CHARS ? `${text.slice(0, DETAIL_COMMENT_CHARS)}…` : text
}

export function hostWriteTitle(card: HostWriteCard): string {
  if (card.action === 'create') return card.create?.draft ? 'Open a draft pull request' : 'Open a pull request'
  if (card.action === 'reply') return card.suggestResolve ? 'Reply and resolve a review conversation' : 'Reply to a review conversation'
  if (card.action === 'resolve') return 'Resolve a review conversation'
  if (card.action === 'comment') return card.lineRange ? `Comment on lines ${card.lineRange.start}-${card.lineRange.end}` : 'Comment on a line'
  if (card.action === 'review') return 'Submit a review'
  return 'Re-run a failed check'
}

/** Only what the card may carry back; anything else a client sends is dropped. */
export function parseHostWriteResponse(value: unknown): HostWriteResponse {
  if (!value || typeof value !== 'object') return {}
  const r = value as Record<string, unknown>
  const comments = Array.isArray(r.comments)
    ? r.comments.flatMap((c: unknown) => {
      const item = c as Record<string, unknown> | null
      return item && typeof item.id === 'string' && typeof item.text === 'string' ? [{ id: item.id, text: item.text }] : []
    })
    : undefined
  return {
    ...(typeof r.text === 'string' ? { text: r.text } : {}),
    ...(typeof r.resolve === 'boolean' ? { resolve: r.resolve } : {}),
    ...(r.verdict === 'comment' || r.verdict === 'approve' || r.verdict === 'request_changes' ? { verdict: r.verdict } : {}),
    ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    ...(comments ? { comments } : {}),
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
  }
}
