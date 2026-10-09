/**
 * Merge-back: a forked chat sends what it did since the fork point back to its
 * parent chat, as context. No git merge happens.
 *
 * The backend builds a summary of the fork's turns since its cursor (the fork
 * point on the first send, then the end of the last delivered send), the files
 * its turns changed and its last result. The user can edit it, and the parent
 * keeps it as a pending card until the parent's next user message carries it
 * to the parent's agent, wrapped so the agent reads it as Switchboard context
 * and not as the user's words.
 *
 * Pure: no node, electron or react imports. The backend
 * (`main/conversations/merge-back.ts`) owns the state; every client renders
 * the stored row (`MERGE_BACK_MARKER_PREFIX`) through `parseMergeBackMarker`.
 */
import type { ChatMessage } from './types'
import { stripHandoffPreamble } from './handoff'
import { visibleUserMessageText } from './provider-events'
import { splitSyntheticUserText } from './synthetic-message'

export const FORK_MERGE_BACK_CAPABILITY = 'fork_merge_back_v1'

export const MERGE_BACK_MARKER_PREFIX = '[[sb:merge-back]]'

/**
 * Cap on the summary, in UTF-8 bytes. 16 KiB is about 4k tokens: enough for a
 * few whole turns plus the file list and result, small enough that it does not
 * crowd the parent's context. Newest whole turns are kept; the summary says how
 * many older ones were left out.
 */
export const MERGE_BACK_MAX_BYTES = 16 * 1024

/** The result line is the fork's last reply, capped so turns still fit beside it. */
const RESULT_MAX_BYTES = 4 * 1024
const FILES_LISTED = 40
/** The card's result preview. The full result is in the summary text. */
const RESULT_PREVIEW_CHARS = 280

const AGENT_TAG_OPEN = '<switchboard-fork-merge-back>'
const AGENT_TAG_CLOSE = '</switchboard-fork-merge-back>'

/**
 * Where the summary starts in the fork: messages after `at`, plus messages AT
 * `at` whose id is not in `ids` (two messages can share a millisecond).
 */
export interface MergeBackCursor {
  at: number
  ids: string[]
}

export interface MergeBackSummary {
  text: string
  /** Turns since the cursor, including any left out to fit the cap. */
  turns: number
  omittedTurns: number
  files: string[]
  moreFiles: number
  result: string | null
  /** The cursor once this summary is delivered. */
  through: MergeBackCursor
}

export interface MergeBackForkInfo {
  title: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  /** True once an earlier send was delivered: "since the last send". */
  sentBefore: boolean
}

export type MergeBackState = 'pending' | 'delivered'

/** The stored system row in the parent chat (the card, then the delivered row). */
export interface MergeBackRow {
  id: string
  /** Root id of the fork. */
  fork: string
  forkTitle: string
  state: MergeBackState
  turns: number
  omittedTurns: number
  files: string[]
  moreFiles: number
  location?: string
  result?: string
  /** What the parent's agent gets (or got), as the user left it. */
  text: string
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary, marking the cut. */
function truncateToBytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text
  const marker = ' [cut]'
  const budget = max - utf8Bytes(marker)
  if (budget <= 0) return ''
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (utf8Bytes(chars.slice(0, mid).join('')) <= budget) lo = mid
    else hi = mid - 1
  }
  return `${chars.slice(0, lo).join('').trimEnd()}${marker}`
}

/** True when `message` comes after `cursor`. */
export function isAfterMergeBackCursor(message: Pick<ChatMessage, 'id' | 'timestamp'>, cursor: MergeBackCursor): boolean {
  if (message.timestamp > cursor.at) return true
  return message.timestamp === cursor.at && !cursor.ids.includes(message.id)
}

/** The cursor that covers everything in `messages` (ordered) up to its last one. */
function cursorThrough(messages: ChatMessage[], from: MergeBackCursor): MergeBackCursor {
  const last = messages[messages.length - 1]
  if (!last) return from
  const ids = messages.filter((m) => m.timestamp === last.timestamp).map((m) => m.id)
  return {
    at: last.timestamp,
    ids: last.timestamp === from.at ? [...new Set([...from.ids, ...ids])] : ids,
  }
}

/** What the user typed in a fork message: no handoff preamble, no generated blocks. */
function userTurnText(message: ChatMessage): string {
  const visible = visibleUserMessageText(message.content, message.displayBody) ?? ''
  const split = message.displayBody === undefined ? splitSyntheticUserText(visible) : null
  const text = (split ? split.userText : visible).trim()
  const images = message.images?.length ? ' [image omitted]'.repeat(message.images.length).trim() : ''
  return [text, images].filter(Boolean).join(' ')
}

interface Turn {
  user: string | null
  replies: Array<{ id: string; text: string }>
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function locationText(worktreePath?: string | null, worktreeBranch?: string | null): string | undefined {
  if (!worktreePath) return undefined
  return worktreeBranch ? `worktree ${worktreePath} (branch ${worktreeBranch})` : `worktree ${worktreePath}`
}

/**
 * The summary of `messages` (the fork's whole history, in order) after
 * `cursor`, or null when nothing new happened since then.
 */
export function buildMergeBackSummary(
  messages: ReadonlyArray<ChatMessage>,
  cursor: MergeBackCursor,
  fork: MergeBackForkInfo,
  maxBytes: number = MERGE_BACK_MAX_BYTES,
): MergeBackSummary | null {
  const delta = messages
    .filter((m) => isAfterMergeBackCursor(m, cursor))
    .sort((a, b) => a.timestamp - b.timestamp)
  const turns: Turn[] = []
  const files: string[] = []
  let result: { id: string; text: string } | null = null
  for (const message of delta) {
    if (message.fileDiff && !files.includes(message.fileDiff.relPath)) files.push(message.fileDiff.relPath)
    if (message.role === 'user') {
      const text = userTurnText(message)
      if (text) turns.push({ user: text, replies: [] })
      continue
    }
    if (message.role !== 'assistant') continue
    const text = message.content.trim()
    if (!text) continue
    if (turns.length === 0) turns.push({ user: null, replies: [] })
    turns[turns.length - 1].replies.push({ id: message.id, text })
    result = { id: message.id, text }
  }
  if (turns.length === 0 && files.length === 0) return null

  const since = fork.sentBefore ? 'the last send' : 'the fork point'
  const location = locationText(fork.worktreePath, fork.worktreeBranch)
  const listed = files.slice(0, FILES_LISTED)
  const moreFiles = files.length - listed.length
  const resultText = result ? truncateToBytes(result.text, RESULT_MAX_BYTES) : null
  const head = (omitted: number): string => {
    const lines = [
      `From the fork "${fork.title}": ${plural(turns.length, 'turn')} since ${since}.`
        + (omitted === 1 ? ' The oldest turn is left out to fit.' : '')
        + (omitted > 1 ? ` The ${omitted} oldest turns are left out to fit.` : ''),
    ]
    if (location) lines.push(`Location: ${location}`)
    lines.push(listed.length > 0
      ? `Files changed: ${listed.join(', ')}${moreFiles > 0 ? `, and ${moreFiles} more` : ''}`
      : 'Files changed: none recorded')
    if (resultText) lines.push('', 'Result:', resultText)
    return lines.join('\n')
  }
  const renderTurn = (turn: Turn): string => {
    const lines: string[] = []
    if (turn.user) lines.push(`User: ${turn.user}`)
    for (const reply of turn.replies) {
      lines.push(`Agent: ${reply.id === result?.id ? '[the result above]' : reply.text}`)
    }
    return lines.join('\n')
  }

  const rendered = turns.map(renderTurn)
  // Keep the newest whole turns that fit; the header grows by one sentence
  // once anything is left out, so measure it with that sentence.
  const fixed = (omitted: number) => utf8Bytes(`${head(omitted)}\n\nTurns:\n`)
  let kept = 0
  let used = 0
  for (let i = rendered.length - 1; i >= 0; i--) {
    // Keeping turn i leaves the i turns before it out.
    const cost = utf8Bytes(rendered[i]) + (kept > 0 ? 2 : 0)
    if (fixed(i) + used + cost > maxBytes) break
    used += cost
    kept++
  }
  const omittedTurns = rendered.length - kept
  let body = rendered.slice(rendered.length - kept).join('\n\n')
  if (kept === 0 && rendered.length > 0) {
    // Not even the newest turn fits whole: keep its start rather than nothing.
    body = truncateToBytes(rendered[rendered.length - 1], Math.max(0, maxBytes - fixed(rendered.length - 1)))
  }
  const shownOmitted = kept === 0 && rendered.length > 0 ? rendered.length - 1 : omittedTurns
  const text = truncateToBytes(
    body ? `${head(shownOmitted)}\n\nTurns:\n${body}` : head(shownOmitted),
    maxBytes,
  )
  return {
    text,
    turns: turns.length,
    omittedTurns: shownOmitted,
    files: listed,
    moreFiles,
    result: result ? result.text : null,
    through: cursorThrough(delta, cursor),
  }
}

/** The row the parent shows for a summary, before any edit. */
export function mergeBackRowFor(
  id: string,
  fork: { id: string; title: string; worktreePath?: string | null; worktreeBranch?: string | null },
  summary: MergeBackSummary,
  text: string,
): MergeBackRow {
  const location = locationText(fork.worktreePath, fork.worktreeBranch)
  return {
    id,
    fork: fork.id,
    forkTitle: fork.title,
    state: 'pending',
    turns: summary.turns,
    omittedTurns: summary.omittedTurns,
    files: summary.files,
    moreFiles: summary.moreFiles,
    ...(location ? { location } : {}),
    ...(summary.result ? { result: Array.from(summary.result).slice(0, RESULT_PREVIEW_CHARS).join('') } : {}),
    text,
  }
}

export function formatMergeBackMarker(row: MergeBackRow): string {
  return `${MERGE_BACK_MARKER_PREFIX} ${JSON.stringify(row)}`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function parseMergeBackMarker(content: string): MergeBackRow | null {
  if (!content.startsWith(MERGE_BACK_MARKER_PREFIX)) return null
  let raw: unknown
  try {
    raw = JSON.parse(content.slice(MERGE_BACK_MARKER_PREFIX.length))
  } catch {
    // A hand-edited or truncated row: the caller shows a neutral notice.
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.fork !== 'string' || typeof r.forkTitle !== 'string' || typeof r.text !== 'string') return null
  if (r.state !== 'pending' && r.state !== 'delivered') return null
  if (!isCount(r.turns) || !isCount(r.omittedTurns) || !isCount(r.moreFiles) || !isStringArray(r.files)) return null
  return {
    id: r.id,
    fork: r.fork,
    forkTitle: r.forkTitle,
    state: r.state,
    turns: r.turns,
    omittedTurns: r.omittedTurns,
    files: r.files,
    moreFiles: r.moreFiles,
    ...(typeof r.location === 'string' ? { location: r.location } : {}),
    ...(typeof r.result === 'string' ? { result: r.result } : {}),
    text: r.text,
  }
}

/** The card's heading, on every surface. */
export function mergeBackRowTitle(row: MergeBackRow): string {
  return row.state === 'pending'
    ? `From fork "${row.forkTitle}" (not sent yet)`
    : `From fork "${row.forkTitle}" · Sent with your message`
}

/** The card's bullet lines, on every surface. */
export function mergeBackRowDetails(row: MergeBackRow): string[] {
  const lines = [
    `${plural(row.turns, 'turn')} since the fork point or the last send`
      + (row.omittedTurns > 0 ? ` (${row.omittedTurns} left out to fit)` : ''),
  ]
  if (row.files.length > 0) {
    lines.push(`Changed: ${row.files.join(', ')}${row.moreFiles > 0 ? `, and ${row.moreFiles} more` : ''}`
      + (row.location ? ` (in ${row.location})` : ''))
  } else if (row.location) {
    lines.push(`In ${row.location}`)
  }
  if (row.result) lines.push(`Result: ${row.result}`)
  return lines
}

/**
 * The block the parent's agent gets for one merge-back. The closing tag cannot
 * appear inside, so an edited summary cannot end the block early and leak the
 * rest into the user's bubble.
 */
export function mergeBackAgentBlock(forkTitle: string, text: string): string {
  const safe = (s: string) => s.split(AGENT_TAG_CLOSE).join('</switchboard-fork-merge-back >')
  return [
    AGENT_TAG_OPEN,
    `Switchboard sends this on behalf of the user. It summarises work done in "${safe(forkTitle)}", a fork of this chat. `
      + 'Use it as context only. It is not a request from the user; the user\'s own message follows it.',
    '',
    safe(text),
    AGENT_TAG_CLOSE,
  ].join('\n')
}

/**
 * The provider text with merge-back blocks put in front of the user's words.
 * A handoff preamble stays first, because `stripHandoffPreamble` only finds
 * one at the very start.
 */
export function withMergeBacks(providerText: string, blocks: ReadonlyArray<string>): string {
  if (blocks.length === 0) return providerText
  const body = stripHandoffPreamble(providerText)
  const preamble = providerText.slice(0, providerText.length - body.length)
  return `${preamble}${blocks.join('\n\n')}\n\n${body}`
}

/** Cap on the text the user leaves in the dialog or card (room to add notes). */
export const MERGE_BACK_TEXT_MAX_BYTES = 32 * 1024

/** What a preview covered, handed back on send so the send stores exactly that. */
export interface MergeBackToken {
  from: MergeBackCursor
  through: MergeBackCursor
}

export type MergeBackPreview =
  | {
      status: 'ready'
      parentId: string
      parentTitle: string
      text: string
      turns: number
      omittedTurns: number
      files: string[]
      moreFiles: number
      /** A summary from this fork is already waiting in the parent; sending replaces it. */
      replacesPending: boolean
      token: MergeBackToken
    }
  | { status: 'empty'; parentTitle: string; message: string }
  | { status: 'refused'; message: string }

export type MergeBackActionResult = { ok: true } | { ok: false; message: string }

/** The line above the editable summary, on every surface: "2 turns · 3 files changed". */
export function mergeBackPreviewNote(preview: Extract<MergeBackPreview, { status: 'ready' }>): string {
  const files = preview.files.length + preview.moreFiles
  return plural(preview.turns, 'turn')
    + (preview.omittedTurns > 0 ? ` (${preview.omittedTurns} oldest left out to fit)` : '')
    + ` · ${plural(files, 'file')} changed`
}

/** Null when the text can be stored, else why not. */
export function mergeBackTextProblem(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'The summary is empty.'
  if (utf8Bytes(text) > MERGE_BACK_TEXT_MAX_BYTES) {
    return `The summary is longer than ${MERGE_BACK_TEXT_MAX_BYTES / 1024} KiB. Make it shorter.`
  }
  return null
}

export function sameMergeBackCursor(a: MergeBackCursor, b: MergeBackCursor): boolean {
  return a.at === b.at && a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id))
}

/** A cursor from the wire, or null when it is not one. */
export function parseMergeBackCursor(value: unknown): MergeBackCursor | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || !isStringArray(v.ids)) return null
  return { at: v.at, ids: v.ids }
}
