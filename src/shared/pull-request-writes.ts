/**
 * The human write actions on a pull request: reply to a conversation,
 * resolve or unresolve it, comment on a line or on the whole PR, submit a
 * review, merge, and re-run a failed check.
 *
 * The client sends these inputs; the backend runs them through the
 * `validate*` functions here before anything reaches a host, whatever the
 * client already checked. The rules both sides share (merge strategy order
 * and default, who may approve, when a review can be submitted, the merge
 * pre-check) are pure and live here too.
 */
import type { MergeStrategy, PrConversation, PrChangedFile, PrDetail, PrError, PrHost, PrViewer } from './pull-requests'

/** GitHub caps a comment at 65,536 characters; stay under it so a host never cuts one. */
export const PR_TEXT_MAX_CHARS = 60_000
/** Pending comments in one review. More is a script, not a review. */
export const PR_REVIEW_MAX_COMMENTS = 50
const PATH_MAX_CHARS = 1_000

export type ReviewEvent = 'comment' | 'approve' | 'request_changes'

export const REVIEW_EVENT_LABEL: Record<ReviewEvent, string> = {
  comment: 'Comment',
  approve: 'Approve',
  request_changes: 'Request changes',
}

export interface InlineCommentInput {
  path: string
  side: 'new' | 'old'
  /** The last line of the selection, on `side`. */
  line: number
  /** The first line when the comment spans several; omitted for one line. */
  startLine?: number
  body: string
}

export interface ReplyInput {
  conversationId: string
  body: string
}

export interface ResolveInput {
  conversationId: string
}

export interface CommentInput {
  body: string
}

export interface SubmitReviewInput {
  event: ReviewEvent
  /** The summary; may be empty for a Comment with pending comments, or an Approve. */
  body: string
  comments: InlineCommentInput[]
}

export interface MergeInput {
  strategy: MergeStrategy
  /** The head the user confirmed. A different head on the host refuses the merge. */
  expectedHeadSha: string
}

export interface RerunInput {
  checkId: string
}

/** The reads a write changed, which the client re-reads after it succeeds. */
export type PrResource = 'detail' | 'files' | 'conversations' | 'checks'

export interface PrWriteDone {
  refresh: PrResource[]
}

// ─── Merge strategies ─────────────────────────────────────────────

export const MERGE_STRATEGY_ORDER: readonly MergeStrategy[] = [
  'merge_commit',
  'fast_forward',
  'rebase_merge',
  'squash',
  'squash_fast_forward',
  'rebase',
]

export const MERGE_STRATEGY_LABEL: Record<MergeStrategy, string> = {
  merge_commit: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase',
  fast_forward: 'Fast forward',
  squash_fast_forward: 'Squash, fast forward only',
  rebase_merge: 'Rebase, then merge commit',
}

export function isMergeStrategy(value: unknown): value is MergeStrategy {
  return typeof value === 'string' && (MERGE_STRATEGY_ORDER as readonly string[]).includes(value)
}

/** What the split button's menu lists: only allowed strategies, merge commit first, no duplicates. */
export function orderMergeStrategies(allowed: readonly MergeStrategy[]): MergeStrategy[] {
  return MERGE_STRATEGY_ORDER.filter((s) => allowed.includes(s))
}

/**
 * The strategy the button uses before the user picks one: a merge commit.
 * Squash and rebase are never a default, so a repository that allows only
 * those has none, and the user picks from the menu.
 */
export function defaultMergeStrategy(allowed: readonly MergeStrategy[]): MergeStrategy | null {
  if (allowed.includes('merge_commit')) return 'merge_commit'
  if (allowed.includes('fast_forward')) return 'fast_forward'
  return null
}

/** The user's pick while the repository still allows it, else the default. */
export function effectiveMergeStrategy(allowed: readonly MergeStrategy[], picked: MergeStrategy | null | undefined): MergeStrategy | null {
  if (picked && allowed.includes(picked)) return picked
  return defaultMergeStrategy(allowed)
}

/**
 * The backend's re-read before a merge: refuse when the PR is not the one
 * the user confirmed (a new head, closed, a blocker appeared) or the
 * strategy is not allowed. `null` means go.
 */
/**
 * Exact match, ignoring case. No prefix matching: a short hash could match a
 * different commit, and Bitbucket's merge call does not send the head, so a
 * false match could merge the wrong commit. Both values come from our own read
 * of the same host, so they always have the same length.
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

export function mergePrecheck(fresh: PrDetail, input: MergeInput): PrError | null {
  const host = fresh.ref.host
  if (fresh.state !== 'open') {
    return { kind: 'stale', host, message: `This pull request is ${fresh.state} now.` }
  }
  if (!sameCommit(fresh.headSha, input.expectedHeadSha)) {
    return { kind: 'stale', host, message: 'New commits were pushed since you looked. Review them, then merge again.' }
  }
  if (fresh.mergeBlockers.length > 0) {
    const what = fresh.mergeBlockers.map((b) => b.label).join(', ')
    return { kind: 'stale', host, message: `Merging is blocked now: ${what}.` }
  }
  if (!fresh.mergeStrategies.includes(input.strategy)) {
    return { kind: 'invalid', host, message: `This repository does not allow ${MERGE_STRATEGY_LABEL[input.strategy].toLowerCase()} merges.` }
  }
  return null
}

// ─── Reviews ──────────────────────────────────────────────────────

/** You cannot approve or request changes on your own PR (both hosts refuse), so the form never offers it. */
export function reviewEventsFor(viewer: Pick<PrViewer, 'isAuthor'>): ReviewEvent[] {
  return viewer.isAuthor ? ['comment'] : ['comment', 'approve', 'request_changes']
}

/** Why Submit is off, or `null` when the review can go. */
export function reviewSubmitProblem(host: PrHost, event: ReviewEvent, body: string, pendingComments: number): string | null {
  const text = body.trim()
  if (text.length > PR_TEXT_MAX_CHARS) return 'The summary is too long.'
  if (event === 'comment' && !text && pendingComments === 0) return 'Write a summary or add a comment on a line first.'
  // GitHub refuses a change request without a body; Bitbucket does not ask for one, but a reviewer should say what to change.
  if (event === 'request_changes' && !text) return host === 'github' ? 'GitHub needs a summary to request changes.' : 'Say what should change.'
  return null
}

// ─── Backend validation ───────────────────────────────────────────

type Valid<T> = { ok: true; value: T } | { ok: false; error: PrError }

function invalid(host: PrHost, message: string): { ok: false; error: PrError } {
  return { ok: false, error: { kind: 'invalid', host, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanText(host: PrHost, value: unknown, what: string, allowEmpty = false): Valid<string> {
  if (typeof value !== 'string') return invalid(host, `${what} is missing.`)
  const text = value.trim()
  if (!allowEmpty && !text) return invalid(host, `${what} is empty.`)
  if (text.length > PR_TEXT_MAX_CHARS) return invalid(host, `${what} is longer than ${PR_TEXT_MAX_CHARS.toLocaleString('en-US')} characters.`)
  // A NUL reaches neither host intact.
  if (text.includes('\u0000')) return invalid(host, `${what} contains a NUL character.`)
  return { ok: true, value: text }
}

/** GitHub thread node ids (`PRRT_...`), Bitbucket numeric comment ids. */
export function isConversationId(host: PrHost, value: unknown): value is string {
  if (typeof value !== 'string') return false
  return host === 'github' ? /^[A-Za-z0-9_=-]{1,200}$/.test(value) : /^[1-9][0-9]{0,18}$/.test(value)
}

function lineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10_000_000
}

export function validateReply(host: PrHost, input: unknown): Valid<ReplyInput> {
  if (!isRecord(input) || !isConversationId(host, input.conversationId)) return invalid(host, 'Not a conversation of this pull request.')
  const body = cleanText(host, input.body, 'The reply')
  if (!body.ok) return body
  return { ok: true, value: { conversationId: input.conversationId, body: body.value } }
}

export function validateResolve(host: PrHost, input: unknown): Valid<ResolveInput> {
  if (!isRecord(input) || !isConversationId(host, input.conversationId)) return invalid(host, 'Not a conversation of this pull request.')
  return { ok: true, value: { conversationId: input.conversationId } }
}

export function validateComment(host: PrHost, input: unknown): Valid<CommentInput> {
  if (!isRecord(input)) return invalid(host, 'The comment is missing.')
  const body = cleanText(host, input.body, 'The comment')
  if (!body.ok) return body
  return { ok: true, value: { body: body.value } }
}

export function validateInlineComment(host: PrHost, input: unknown): Valid<InlineCommentInput> {
  if (!isRecord(input)) return invalid(host, 'The comment is missing.')
  const { path, side, line, startLine } = input
  if (typeof path !== 'string' || !path || path.length > PATH_MAX_CHARS || path.includes('\u0000') || path.startsWith('/')) {
    return invalid(host, 'Not a file of this pull request.')
  }
  if (side !== 'new' && side !== 'old') return invalid(host, 'Not a side of the diff.')
  if (!lineNumber(line)) return invalid(host, 'Not a line number.')
  if (startLine !== undefined && (!lineNumber(startLine) || startLine > line)) return invalid(host, 'Not a line range.')
  const body = cleanText(host, input.body, 'The comment')
  if (!body.ok) return body
  const out: InlineCommentInput = { path, side, line, body: body.value }
  if (startLine !== undefined && startLine < line) out.startLine = startLine
  return { ok: true, value: out }
}

export function validateSubmitReview(host: PrHost, input: unknown): Valid<SubmitReviewInput> {
  if (!isRecord(input)) return invalid(host, 'The review is missing.')
  const { event } = input
  if (event !== 'comment' && event !== 'approve' && event !== 'request_changes') return invalid(host, 'Not a review type.')
  const body = cleanText(host, input.body ?? '', 'The summary', true)
  if (!body.ok) return body
  if (!Array.isArray(input.comments)) return invalid(host, 'The pending comments are missing.')
  if (input.comments.length > PR_REVIEW_MAX_COMMENTS) return invalid(host, `A review holds at most ${PR_REVIEW_MAX_COMMENTS} comments.`)
  const comments: InlineCommentInput[] = []
  for (const raw of input.comments) {
    const c = validateInlineComment(host, raw)
    if (!c.ok) return c
    comments.push(c.value)
  }
  const problem = reviewSubmitProblem(host, event, body.value, comments.length)
  if (problem) return invalid(host, problem)
  return { ok: true, value: { event, body: body.value, comments } }
}

export function validateMerge(host: PrHost, input: unknown): Valid<MergeInput> {
  if (!isRecord(input) || !isMergeStrategy(input.strategy)) return invalid(host, 'Not a merge strategy.')
  if (typeof input.expectedHeadSha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(input.expectedHeadSha)) {
    return invalid(host, 'The head commit you confirmed is missing.')
  }
  return { ok: true, value: { strategy: input.strategy, expectedHeadSha: input.expectedHeadSha.toLowerCase() } }
}

export function validateRerun(host: PrHost, input: unknown): Valid<RerunInput> {
  if (!isRecord(input) || typeof input.checkId !== 'string' || !input.checkId || input.checkId.length > 500) {
    return invalid(host, 'Not a check of this pull request.')
  }
  return { ok: true, value: { checkId: input.checkId } }
}

// ─── Checks against the fresh PR ──────────────────────────────────

/** A reply or resolve targets a conversation the host still lists on this PR. */
export function findConversation(conversations: readonly PrConversation[], id: string): PrConversation | null {
  return conversations.find((c) => c.id === id) ?? null
}

/** A line comment must land on a line the diff shows on that side, or the host refuses it (GitHub) or anchors it nowhere (Bitbucket). */
export function lineInDiff(files: readonly PrChangedFile[], c: Pick<InlineCommentInput, 'path' | 'side' | 'line' | 'startLine'>): boolean {
  const file = files.find((f) => f.path === c.path)
  if (!file) return false
  const shown = new Set<number>()
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      const n = c.side === 'old' ? (l.kind !== 'add' ? l.oldLine : null) : (l.kind !== 'del' ? l.newLine : null)
      if (n !== null) shown.add(n)
    }
  }
  return shown.has(c.line) && (c.startLine === undefined || shown.has(c.startLine))
}
