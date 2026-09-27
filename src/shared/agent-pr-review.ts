/**
 * The rules for the two agent tools that start new comments on a pull
 * request: `comment_on_line` (one inline comment) and `draft_review` (a
 * summary plus inline comments the user submits with a verdict of their own choosing).
 *
 * Pure and shared: the server checks the agent's draft with them, the card
 * checks the user's edits with the same functions, and the server checks the
 * card's answer again before anything is posted.
 */
import {
  AGENT_REPLY_MAX_CHARS,
  AGENT_REVIEW_MAX_BYTES,
  AGENT_REVIEW_MAX_COMMENTS,
  type HostWriteDiffLine,
  type HostWriteResponse,
  type HostWriteReview,
} from './agent-host-writes'
import { reviewSubmitProblem, type ReviewEvent } from './pull-request-writes'
import type { PrChangedFile, PrHost } from './pull-requests'

export interface DraftLineComment {
  path: string
  side: 'new' | 'old'
  line: number
  text: string
}

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

/** The longest diff line the card shows; a minified line would push it sideways for nothing. */
const EXCERPT_LINE_CHARS = 240

/** "src/a.ts:12", with "(old)" when it is a line of the old side. */
export function lineLocation(c: Pick<DraftLineComment, 'path' | 'side' | 'line'>): string {
  return `${c.path}:${c.line}${c.side === 'old' ? ' (old)' : ''}`
}

/** The target line and up to `radius` diff lines either side of it, inside its hunk. Empty when the line is not in the diff. */
export function diffExcerpt(
  files: readonly PrChangedFile[],
  target: Pick<DraftLineComment, 'path' | 'side' | 'line'>,
  radius: number,
): HostWriteDiffLine[] {
  const file = files.find((f) => f.path === target.path)
  if (!file) return []
  for (const hunk of file.hunks) {
    const at = hunk.lines.findIndex((l) =>
      target.side === 'old' ? l.kind !== 'add' && l.oldLine === target.line : l.kind !== 'del' && l.newLine === target.line,
    )
    if (at < 0) continue
    const targetLine = hunk.lines[at]
    return hunk.lines.slice(Math.max(0, at - radius), at + radius + 1).map((l) => ({
      kind: l.kind,
      text: l.text.length > EXCERPT_LINE_CHARS ? `${l.text.slice(0, EXCERPT_LINE_CHARS)}…` : l.text,
      oldLine: l.oldLine,
      newLine: l.newLine,
      target: l === targetLine,
    }))
  }
  return []
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10_000_000
}

/** One comment's text: the agent's and the user's, under the same rule as a reply. */
export function checkCommentText(value: unknown, what = 'The comment'): Checked<string> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: `${what} is empty.` }
  const text = value.trim()
  if (text.length > AGENT_REPLY_MAX_CHARS) {
    return { ok: false, message: `${what} is ${text.length} characters; the limit is ${AGENT_REPLY_MAX_CHARS}. Say it shorter.` }
  }
  return { ok: true, value: text }
}

/** The target of a line comment as the agent sent it. Whether the diff shows that line is checked against the fresh diff. */
export function checkLineTarget(input: Record<string, unknown>): Checked<Omit<DraftLineComment, 'text'>> {
  const { path, side, line } = input
  if (typeof path !== 'string' || !path.trim() || path.startsWith('/') || path.includes('\u0000')) {
    return { ok: false, message: 'Give "path" as the file path the diff shows, relative to the repository root.' }
  }
  if (side !== undefined && side !== 'new' && side !== 'old') return { ok: false, message: '"side" is "new" (added or unchanged lines) or "old" (deleted lines).' }
  if (!isLine(line)) return { ok: false, message: '"line" is a line number from get_pr_diff.' }
  return { ok: true, value: { path: path.trim(), side: side === 'old' ? 'old' : 'new', line } }
}

const utf8 = new TextEncoder()

function draftBytes(summary: string, comments: readonly { text: string }[]): number {
  return utf8.encode(summary).length + comments.reduce((n, c) => n + utf8.encode(c.text).length, 0)
}

/** Size rules for a whole draft, the agent's or the one the user left in the card. */
export function reviewSizeProblem(summary: string, comments: readonly { text: string }[]): string | null {
  if (summary.length > AGENT_REPLY_MAX_CHARS) return `The summary is ${summary.length} characters; the limit is ${AGENT_REPLY_MAX_CHARS}.`
  if (comments.length > AGENT_REVIEW_MAX_COMMENTS) return `A draft review holds at most ${AGENT_REVIEW_MAX_COMMENTS} comments; this one has ${comments.length}.`
  const bytes = draftBytes(summary, comments)
  if (bytes > AGENT_REVIEW_MAX_BYTES) {
    return `The review is ${Math.ceil(bytes / 1024)} KiB; the limit is ${AGENT_REVIEW_MAX_BYTES / 1024} KiB for the summary and every comment together.`
  }
  return null
}

/** The agent's `draft_review` arguments. There is no verdict among them, and one that is sent is refused. */
export function checkReviewDraft(args: Record<string, unknown>): Checked<{ summary: string; comments: DraftLineComment[] }> {
  for (const key of ['verdict', 'event', 'approve', 'requestChanges', 'request_changes']) {
    if (key in args) return { ok: false, message: `There is no "${key}" argument: the user picks Comment, Request changes or Approve in the card. Send the draft without it.` }
  }
  const summary = checkCommentText(args.summary, 'The summary')
  if (!summary.ok) return summary
  if (!Array.isArray(args.comments)) return { ok: false, message: '"comments" is a list (it may be empty).' }
  if (args.comments.length > AGENT_REVIEW_MAX_COMMENTS) {
    return { ok: false, message: `A draft review holds at most ${AGENT_REVIEW_MAX_COMMENTS} comments; this one has ${args.comments.length}. Keep the ones that matter most.` }
  }
  const comments: DraftLineComment[] = []
  for (const [i, raw] of args.comments.entries()) {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const target = checkLineTarget(item)
    if (!target.ok) return { ok: false, message: `Comment ${i + 1}: ${target.message}` }
    const text = checkCommentText(item.text)
    if (!text.ok) return { ok: false, message: `Comment ${i + 1}: ${text.message}` }
    comments.push({ ...target.value, text: text.value })
  }
  const size = reviewSizeProblem(summary.value, comments)
  return size ? { ok: false, message: size } : { ok: true, value: { summary: summary.value, comments } }
}

/** Why the card cannot submit this verdict with this draft, or null. Host rules first, then the size rules. */
export function reviewVerdictProblem(
  host: PrHost,
  review: Pick<HostWriteReview, 'verdicts'>,
  verdict: ReviewEvent,
  summary: string,
  comments: readonly { text: string }[],
): string | null {
  if (!review.verdicts.includes(verdict)) return verdict === 'comment' ? 'Comment is not offered here.' : 'You cannot approve or request changes on your own pull request.'
  const empty = comments.findIndex((c) => !c.text.trim())
  if (empty >= 0) return `Comment ${empty + 1} is empty. Write it or remove it.`
  return reviewSubmitProblem(host, verdict, summary, comments.length) ?? reviewSizeProblem(summary.trim(), comments.map((c) => ({ text: c.text.trim() })))
}

/**
 * The review the card's answer asks for: the verdict the USER picked, the
 * summary and the comments they kept, as edited. The agent's draft supplies the
 * targets only; a comment id the card did not show is ignored.
 */
export function reviewFromResponse(
  host: PrHost,
  review: HostWriteReview,
  response: HostWriteResponse,
): Checked<{ verdict: ReviewEvent; summary: string; comments: DraftLineComment[]; removed: number; edited: number }> {
  const verdict = response.verdict
  if (!verdict) return { ok: false, message: 'The card was answered without a verdict, so nothing was posted. The user picks it in the Switchboard card.' }
  const summary = (response.summary ?? review.summary).trim()
  const answers = new Map((response.comments ?? review.comments).map((c) => [c.id, c.text]))
  const comments: DraftLineComment[] = []
  let edited = 0
  for (const c of review.comments) {
    const text = answers.get(c.id)
    if (text === undefined) continue
    if (text.trim() !== c.text) edited++
    comments.push({ path: c.path, side: c.side, line: c.line, text: text.trim() })
  }
  const problem = reviewVerdictProblem(host, review, verdict, summary, comments)
  if (problem) return { ok: false, message: `${problem} Nothing was posted.` }
  return { ok: true, value: { verdict, summary, comments, removed: review.comments.length - comments.length, edited } }
}
