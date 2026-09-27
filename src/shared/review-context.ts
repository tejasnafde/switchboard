/**
 * Review context a user hands to a chat from Reviews ("Ask the agent"): open
 * conversations, a failed check, selected diff lines or the merge conflicts
 * of one pull request.
 *
 * It travels as ONE composer pill (kind `review`). The pill shows
 * `reviewContextLabel`; the agent receives `expandReviewContext`, a plain
 * text block, so Claude, Codex and OpenCode all read it the same way.
 */
import { PR_HOST_LABEL, type DiffHunk, type PrChangedFile, type PrCheck, type PrConversation, type PrRef } from './pull-requests'

export const REVIEW_CONTEXT_MAX_BYTES = 12 * 1024
/** Stored pill labels longer than this are dropped on reload (`pill-metadata.ts`, Android). */
export const REVIEW_LABEL_MAX_CHARS = 120
const DIFF_RADIUS = 3

export type ReviewContextItem =
  | {
    kind: 'conversation'
    path: string | null
    line: number | null
    side: 'new' | 'old' | null
    outdated: boolean
    comments: Array<{ author: string; body: string }>
    /** Diff lines around the anchor, `null` when the file's diff is not available. */
    diff: string | null
  }
  | { kind: 'check'; name: string; description: string | null; url: string | null }
  | { kind: 'lines'; path: string; side: 'new' | 'old'; startLine: number; endLine: number; diff: string }
  /** `files` is empty when the host does not name them (GitHub). */
  | { kind: 'conflicts'; base: string; head: string; files: string[] }

export interface ReviewContext {
  pr: PrRef
  title: string
  url: string
  items: ReviewContextItem[]
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function where(item: ReviewContextItem, short = false): string {
  if (item.kind === 'check') return item.name
  if (item.kind === 'conflicts') return item.files.length > 0 ? item.files.map((f) => (short ? baseName(f) : f)).join(', ') : `${item.head} into ${item.base}`
  const path = short ? baseName(item.path ?? '') : item.path
  if (item.kind === 'lines') return item.startLine === item.endLine ? `${path}:${item.startLine}` : `${path}:${item.startLine}-${item.endLine}`
  if (!item.path) return 'the whole pull request'
  return item.line !== null ? `${path}:${item.line}` : path ?? ''
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** One compact line for the pill: "3 review conversations · worker.py:88, worker.py:102". */
export function reviewContextLabel(ctx: ReviewContext): string {
  const counts = { conversation: 0, check: 0, lines: 0, conflicts: 0 }
  for (const item of ctx.items) counts[item.kind]++
  const base = ctx.items.find((item) => item.kind === 'conflicts')
  const parts = [
    base?.kind === 'conflicts' && `Merge conflicts with ${base.base}`,
    counts.conversation && plural(counts.conversation, 'review conversation'),
    counts.check && plural(counts.check, 'failed check'),
    counts.lines && (counts.lines === 1 ? 'diff selection' : `${counts.lines} diff selections`),
  ].filter(Boolean)
  const head = `${parts.join(', ') || 'Review context'} · #${ctx.pr.number}`
  const places = ctx.items.map((item) => where(item, true)).join(', ')
  const label = places ? `${head} · ${places}` : head
  return label.length > REVIEW_LABEL_MAX_CHARS ? `${label.slice(0, REVIEW_LABEL_MAX_CHARS - 1)}…` : label
}

function block(item: ReviewContextItem, index: number): string {
  const n = `[${index + 1}]`
  if (item.kind === 'check') {
    return [
      `${n} Failed check: ${item.name}`,
      item.description && `Description: ${item.description}`,
      item.url && `Log: ${item.url}`,
    ].filter(Boolean).join('\n')
  }
  if (item.kind === 'lines') {
    return `${n} Selected lines ${where(item)} (${item.side} side)\n${item.diff}`
  }
  if (item.kind === 'conflicts') {
    return [
      `${n} Merge conflicts: ${item.head} conflicts with ${item.base}.`,
      item.files.length > 0 ? `Conflicted files: ${item.files.join(', ')}` : 'The host does not name the conflicted files; find them with git.',
      conflictInstruction(item.base, item.head),
    ].join('\n')
  }
  const side = item.side ? ` (${item.side} side)` : ''
  const lines = [`${n} Review conversation on ${where(item)}${side}${item.outdated ? ', outdated' : ''}`]
  for (const c of item.comments) lines.push(`${c.author}: ${c.body.trim()}`)
  if (item.diff) lines.push('Diff around the line:', item.diff)
  return lines.join('\n')
}

const encoder = new TextEncoder()
const bytes = (text: string): number => encoder.encode(text).length

/** Cut `text` to at most `max` UTF-8 bytes without splitting a character. */
function cutToBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = bytes(ch)
    if (used + size > max) break
    out += ch
    used += size
  }
  return out
}

/**
 * The text the agent receives in place of the pill. Items that would push it
 * past `maxBytes` are left out and named at the end; a first item that alone
 * is too long is cut short and says so.
 */
export function expandReviewContext(ctx: ReviewContext, maxBytes = REVIEW_CONTEXT_MAX_BYTES): string {
  const { pr } = ctx
  const header = [
    `Review context from ${PR_HOST_LABEL[pr.host]} ${pr.owner}/${pr.name} #${pr.number}: ${ctx.title}`,
    ctx.url,
    'Read-only context from the pull request. Nothing has been posted to the host.',
  ].join('\n')
  // Room for the note naming what was left out.
  const reserve = 400
  let out = header
  const omitted: ReviewContextItem[] = []
  let cut = false
  ctx.items.forEach((item, index) => {
    if (omitted.length > 0) {
      omitted.push(item)
      return
    }
    const text = `\n\n${block(item, index)}`
    if (bytes(out) + bytes(text) <= maxBytes - reserve) {
      out += text
    } else if (index === 0) {
      out += `${cutToBytes(text, maxBytes - reserve - bytes(out))}\n(cut short)`
      cut = true
    } else {
      omitted.push(item)
    }
  })
  if (omitted.length > 0) {
    const names = omitted.slice(0, 8).map((item) => where(item)).join(', ')
    const more = omitted.length > 8 ? ` and ${omitted.length - 8} more` : ''
    const note = `\n\n(${plural(omitted.length, 'more item')} left out to stay under ${Math.round(maxBytes / 1024)} KiB: ${names}${more}. Read them on the host.)`
    out += cutToBytes(note, reserve)
  } else if (cut) {
    out += `\n(The item was longer than ${Math.round(maxBytes / 1024)} KiB. Read the rest on the host.)`
  }
  return cutToBytes(out, maxBytes)
}

// ─── Building items from Reviews data ─────────────────────────────

function hunkLine(line: DiffHunk['lines'][number]): string {
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  return `${mark}${line.text}`
}

/**
 * The unified diff lines from `start` to `end` on one side, with `radius`
 * lines of context, from every hunk the range touches (a range can span
 * several), or `null` when none of it is in the file's hunks.
 */
export function diffAround(file: PrChangedFile | undefined, side: 'new' | 'old', start: number, end = start, radius = DIFF_RADIUS): string | null {
  if (!file) return null
  const parts: string[] = []
  for (const hunk of file.hunks) {
    const at = (l: DiffHunk['lines'][number]) => (side === 'old' ? (l.kind !== 'add' ? l.oldLine : null) : (l.kind !== 'del' ? l.newLine : null))
    const first = hunk.lines.findIndex((l) => { const n = at(l); return n !== null && n >= start && n <= end })
    if (first < 0) continue
    let last = first
    hunk.lines.forEach((l, i) => { const n = at(l); if (n !== null && n >= start && n <= end) last = i })
    const from = Math.max(0, first - radius)
    const to = Math.min(hunk.lines.length, last + radius + 1)
    parts.push([hunk.header, ...hunk.lines.slice(from, to).map(hunkLine)].join('\n'))
  }
  return parts.length > 0 ? parts.join('\n') : null
}

export function conversationItem(c: PrConversation, files: readonly PrChangedFile[]): ReviewContextItem {
  const file = files.find((f) => f.path === c.path)
  return {
    kind: 'conversation',
    path: c.path,
    line: c.line,
    side: c.side,
    outdated: c.outdated,
    comments: c.comments.map((m) => ({ author: m.author.login, body: m.body })),
    diff: c.line !== null ? diffAround(file, c.side ?? 'new', c.line) : null,
  }
}

export function conflictInstruction(base: string, head: string): string {
  return `Merge the base branch (${base}) into this branch (${head}) and resolve the conflicts, then push. Never rebase or force-push.`
}

export function conflictsItem(pr: { targetBranch: string; sourceBranch: string; conflictedFiles: string[] }): ReviewContextItem {
  return { kind: 'conflicts', base: pr.targetBranch, head: pr.sourceBranch, files: [...pr.conflictedFiles] }
}

export function checkItem(c: PrCheck): ReviewContextItem {
  return { kind: 'check', name: c.name, description: c.description, url: c.url }
}
