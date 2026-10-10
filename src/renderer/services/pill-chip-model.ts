/**
 * What a context chip shows, derived from the pill's stored label and kind
 * and, when the caller has it, the text the pill expands to. Pure, so the
 * composer chip and the sent-bubble chip read the same rules.
 *
 * The stored pill metadata is only `{ label, kind }`, so everything here is
 * read back out of the label shapes the capture paths write:
 *   terminal      `api (12 lines)`            (context-bridge.ts)
 *   file          `auth.ts (1-7)` or `auth.ts` (IDE selection, @-mention)
 *   chat-message  `Claude: "first line…"`, `you: "…"` for the user's own
 *   review        `2 review conversations · #612 · places` (review-context.ts)
 */
import type { UserMessagePillKind } from '@shared/provider-events'

export type PillChipKind = 'file' | 'terminal' | 'chat-message' | 'you' | 'review'

export type PillChipTarget =
  | { type: 'file'; path: string; startLine: number | null; endLine: number | null }
  | { type: 'terminal'; paneLabel: string }
  | { type: 'message'; role: 'user' | 'assistant'; quote: string }

export interface PillChipModel {
  kind: PillChipKind
  /** Full name; the chip shortens it (`splitChipName`), the card does not. */
  name: string
  /** Text after the chip's hairline. Null for a count of one or an unknown one. */
  count: string | null
  /** Card header: what the chip came from. */
  source: string
  /** Card header after the source, with singular counts kept (`1 line`, `line 42`). */
  detail: string | null
  /** Card header, right side: the command, the path, or the review's places. */
  where: string | null
  /** At most `PREVIEW_LINES` lines of the captured text. */
  preview: string[]
  /** Lines of captured text past the preview. */
  moreLines: number
  /** What a click opens. Null when the chip has no source to open. */
  target: PillChipTarget | null
}

export const PREVIEW_LINES = 4
/** Characters a file name keeps before it is cut in the middle. */
export const CHIP_NAME_MAX = 24
const NAME_TAIL = 9

const SOURCE: Record<PillChipKind, string> = {
  file: 'File',
  terminal: 'Terminal',
  'chat-message': 'Message',
  you: 'Your message',
  review: 'Review',
}

/** The "You" kind is a chat-message pill quoting the user's own bubble. */
export function pillChipKind(kind: UserMessagePillKind, label: string): PillChipKind {
  if (kind === 'chat-message' && /^you: "/.test(label)) return 'you'
  return kind
}

/** `n unit`, with `units` past one. */
function plural(n: number, unit: string, units = `${unit}s`): string {
  return `${n} ${n === 1 ? unit : units}`
}

/** Count text for the chip: a count of one is dropped. */
function chipCount(n: number | null, unit: string, units?: string): string | null {
  return n !== null && n > 1 ? plural(n, unit, units) : null
}

function trimBlankLines(lines: string[]): string[] {
  const out = [...lines]
  while (out.length && !out[out.length - 1].trim()) out.pop()
  while (out.length && !out[0].trim()) out.shift()
  return out
}

/** Lines inside a ``` fence that opens the text, or the text's lines when it has none. */
function unfence(text: string): string[] {
  const lines = text.split('\n')
  if (lines[0]?.startsWith('```')) {
    const close = lines.findIndex((line, i) => i > 0 && line.startsWith('```'))
    return close === -1 ? lines.slice(1) : lines.slice(1, close)
  }
  return lines
}

interface Parsed {
  lines: string[]
  where: string | null
  path: string | null
  startLine: number | null
  endLine: number | null
}

const NOTHING: Parsed = { lines: [], where: null, path: null, startLine: null, endLine: null }

/** The captured text inside a pill's expansion, minus the wrapper its formatter adds. */
function parseContent(kind: UserMessagePillKind, content: string): Parsed {
  const text = content.replace(/\s+$/, '')
  if (!text) return NOTHING
  if (kind === 'terminal') {
    const [head, ...rest] = text.split('\n')
    const header = /^\[from: .* @ [^·\]]*?(?: · (.*))?\]$/.exec(head)
    if (!header) return { ...NOTHING, lines: trimBlankLines(text.split('\n')) }
    const body = rest.join('\n').replace(/\n_\(output truncated\)_$/, '')
    return { ...NOTHING, lines: trimBlankLines(unfence(body)), where: header[1] ?? null }
  }
  if (kind === 'file') {
    const [head, ...rest] = text.split('\n')
    const ref = /^@(\S+?)(?::(\d+)(?:-(\d+))?)?$/.exec(head)
    if (!ref) return { ...NOTHING, lines: trimBlankLines(unfence(text)) }
    const startLine = ref[2] ? Number(ref[2]) : null
    return {
      lines: trimBlankLines(unfence(rest.join('\n'))),
      where: ref[1],
      path: ref[1],
      startLine,
      endLine: ref[3] ? Number(ref[3]) : startLine,
    }
  }
  if (kind === 'chat-message') {
    const lines = text.split('\n').map((line, i) => {
      if (i === 0) {
        const head = /^> from [^:]*: "(.*)"$/.exec(line)
        return head ? head[1] : line
      }
      return line.replace(/^> ?/, '')
    })
    return { ...NOTHING, lines: trimBlankLines(lines) }
  }
  return { ...NOTHING, lines: text.split('\n').filter((line) => line.trim()) }
}

/** Build the chip and card text for a pill. `content` is the text it expands to, when known. */
export function pillChipModel(input: { kind: UserMessagePillKind; label: string; content?: string | null }): PillChipModel {
  const { kind: stored, label } = input
  const kind = pillChipKind(stored, label)
  const parsed = input.content ? parseContent(stored, input.content) : NOTHING
  const preview = parsed.lines.slice(0, PREVIEW_LINES)
  const base = {
    kind,
    source: SOURCE[kind],
    where: parsed.where,
    preview,
    moreLines: Math.max(0, parsed.lines.length - preview.length),
  }

  if (stored === 'terminal') {
    const m = /^(.*) \((\d+) lines?\)$/.exec(label)
    const name = m ? m[1] : label
    const lines = m ? Number(m[2]) : (parsed.lines.length || null)
    return {
      ...base,
      name,
      count: chipCount(lines, 'line'),
      detail: lines !== null ? plural(lines, 'line') : null,
      target: { type: 'terminal', paneLabel: name },
    }
  }

  if (stored === 'file') {
    const m = /^(.*) \((\d+)(?:-(\d+))?\)$/.exec(label)
    const name = m ? m[1] : label
    const start = m ? Number(m[2]) : parsed.startLine
    const end = m ? (m[3] ? Number(m[3]) : start) : parsed.endLine
    const range = start !== null && end !== null && end !== start ? `${start}–${end}` : null
    return {
      ...base,
      name,
      count: range,
      detail: range ? `lines ${range}` : start !== null ? `line ${start}` : null,
      target: parsed.path ? { type: 'file', path: parsed.path, startLine: start, endLine: end } : null,
    }
  }

  if (stored === 'chat-message') {
    const m = /^([^:]+): "([\s\S]*)$/.exec(label)
    const author = m ? m[1] : null
    const name = kind === 'you' ? 'You' : (author ?? label)
    const lines = parsed.lines.length || null
    const quote = parsed.lines[0] ?? (m ? m[2].replace(/"$/, '').replace(/…$/, '') : '')
    return {
      ...base,
      name,
      count: chipCount(lines, 'line'),
      detail: lines !== null ? plural(lines, 'line') : null,
      target: quote.trim() ? { type: 'message', role: kind === 'you' ? 'user' : 'assistant', quote: quote.trim() } : null,
    }
  }

  // Review: `<counts> · #<n> · <places>`.
  const [head = label, pr, ...places] = label.split(' · ')
  const number = /^#(\d+)$/.exec(pr ?? '')
  const threads = /(\d+) review conversations?/.exec(head)?.[1]
  const checks = /(\d+) failed checks?/.exec(head)?.[1]
  const selections = /(\d+) diff selections/.exec(head)?.[1] ?? (/\bdiff selection\b/.test(head) ? '1' : undefined)
  const [n, unit, units]: [number | null, string, string] = threads
    ? [Number(threads), 'thread', 'threads']
    : checks
      ? [Number(checks), 'check', 'checks']
      : selections
        ? [Number(selections), 'selection', 'selections']
        : [null, '', '']
  return {
    ...base,
    name: number ? `PR #${number[1]}` : head,
    count: n !== null ? chipCount(n, unit, units) : null,
    detail: n !== null ? plural(n, unit, units) : head,
    where: places.length ? places.join(' · ') : null,
    target: null,
  }
}

/**
 * A long file name cut in the middle so its extension stays (`provider-regi…eamble.ts`),
 * the way editors shorten tabs. Other names are short already or end-ellipsed by CSS.
 */
export function splitChipName(kind: PillChipKind, name: string, max = CHIP_NAME_MAX): { head: string; tail: string } {
  if (kind !== 'file' || name.length <= max) return { head: name, tail: '' }
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const tailLength = Math.min(Math.max(NAME_TAIL, ext.length), max - 4)
  const tail = name.slice(name.length - tailLength)
  return { head: `${name.slice(0, max - 2 - tailLength)}…`, tail }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The text a sent pill expanded to, found in the message the agent received.
 * Sent pills store only their label, so the bubble chip looks for the block its
 * capture path writes. Null when it cannot be found (a review, an edited or
 * wrapped message), which leaves the chip with what its label says.
 */
export function pillContentInMessage(kind: UserMessagePillKind, label: string, text: string): string | null {
  if (!text) return null
  if (kind === 'terminal') {
    const name = /^(.*) \(\d+ lines?\)$/.exec(label)?.[1] ?? label
    const start = text.indexOf(`[from: ${name} @ `)
    if (start === -1) return null
    const headEnd = text.indexOf('\n', start)
    if (headEnd === -1) return null
    const rest = text.slice(headEnd + 1)
    let end: number
    if (rest.startsWith('```\n')) {
      const close = rest.indexOf('\n```', 3)
      end = close === -1 ? rest.length : close + 4
    } else {
      const nl = rest.indexOf('\n')
      end = nl === -1 ? rest.length : nl
    }
    const truncated = '\n_(output truncated)_'
    if (rest.startsWith(truncated, end)) end += truncated.length
    return text.slice(start, headEnd + 1 + end)
  }
  if (kind === 'file') {
    const m = /^(.*) \((\d+(?:-\d+)?)\)$/.exec(label)
    const name = m ? m[1] : label
    const path = `@((?:\\S*/)?${escapeRegExp(name)})`
    if (!m) return new RegExp(`${path}(?=\\s|$)`).exec(text)?.[0] ?? null
    const head = new RegExp(`${path}:${escapeRegExp(m[2])}\\n\`\`\`\\n`).exec(text)
    if (!head) return null
    const close = text.indexOf('\n```', head.index + head[0].length - 1)
    return text.slice(head.index, close === -1 ? text.length : close + 4)
  }
  if (kind === 'chat-message') {
    const m = /^([^:]+): "([\s\S]*)$/.exec(label)
    if (!m) return null
    const preview = m[2].replace(/"$/, '').replace(/…$/, '')
    const start = text.indexOf(`> from ${m[1]}: "${preview}`)
    if (start === -1) return null
    const lines = text.slice(start).split('\n')
    let count = 1
    while (count < lines.length && lines[count].startsWith('> ')) count++
    return lines.slice(0, count).join('\n')
  }
  return null
}
