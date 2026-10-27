/**
 * What a context chip shows, derived from the pill's stored label and kind
 * and, when the caller has it, the text the pill expands to. Pure, so the
 * composer chip and the sent-bubble chip read the same rules.
 *
 * The stored pill metadata is `{ label, kind }` (plus, for a Cmd+L quote, its
 * source chat and message), so everything else is read back out of the label
 * shapes the capture paths write:
 *   terminal      `api (12 lines)`            (context-bridge.ts)
 *   file          `auth.ts (1-7)` or `auth.ts` (IDE selection, @-mention),
 *                 `spec.pdf (12 pages)`, `shots/ (14 files)` (composer attachment)
 *   chat-message  `Claude: "first line…"`, `you: "…"` for the user's own
 *   review        `2 review conversations · #612 · places` (review-context.ts)
 */
import type { UserMessagePillKind } from '@shared/provider-events'
import { parseAttachmentLine } from '@shared/attachments'

export type PillChipKind = 'file' | 'terminal' | 'chat-message' | 'you' | 'review'

export type PillChipTarget =
  | { type: 'file'; path: string; startLine: number | null; endLine: number | null }
  | { type: 'terminal'; paneLabel: string }
  | { type: 'message'; role: 'user' | 'assistant'; quote: string; source: PillSource | null }
  /** `repo` is `owner/name`, read from the expansion's header when the chip has it. */
  | { type: 'review'; number: number; repo: string | null }

/** The chat and message a Cmd+L chip was quoted from. Older pills have none and open by quote. */
export interface PillSource {
  conversationId: string
  messageId: string
}

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
  /** All of the captured text, as the viewer shows it. Empty when the chip has no text. */
  lines: string[]
  /** Line number of `lines[0]`: the file's own for a file range, 1 otherwise. */
  firstLine: number
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
  repo?: string | null
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
  const repo = /^Review context from \S+ (\S+) #\d+:/.exec(text)?.[1] ?? null
  return { ...NOTHING, lines: trimBlankLines(text.split('\n')), repo }
}

/** Build the chip and card text for a pill. `content` is the text it expands to, when known. */
export function pillChipModel(input: {
  kind: UserMessagePillKind
  label: string
  content?: string | null
  source?: PillSource | null
}): PillChipModel {
  const { kind: stored, label } = input
  const kind = pillChipKind(stored, label)
  const parsed = input.content ? parseContent(stored, input.content) : NOTHING
  // The review card previews its text lines; the blank lines between blocks are for the viewer.
  const previewLines = stored === 'review' ? parsed.lines.filter((line) => line.trim()) : parsed.lines
  const preview = previewLines.slice(0, PREVIEW_LINES)
  const base = {
    kind,
    source: SOURCE[kind],
    where: parsed.where,
    preview,
    moreLines: Math.max(0, previewLines.length - preview.length),
    lines: parsed.lines,
    firstLine: 1,
  }

  if (stored === 'terminal') {
    const m = /^(.*) \((\d+) lines?\)$/.exec(label)
    const name = m ? m[1] : label
    const lines = m ? Number(m[2]) : parsed.lines.length || null
    return {
      ...base,
      name,
      count: chipCount(lines, 'line'),
      detail: lines !== null ? plural(lines, 'line') : null,
      target: { type: 'terminal', paneLabel: name },
    }
  }

  // A composer attachment: its content is the saved-path line, its label may end in a count.
  const attachment = stored === 'file' && input.content ? parseAttachmentLine(input.content) : null
  const counted = stored === 'file' ? /^(.*) \(([\d,]+ (?:pages?|files?|lines?))\)$/.exec(label) : null
  if (attachment || counted) {
    return {
      ...base,
      kind: 'file',
      source: attachment?.kind === 'folder' ? 'Folder' : 'Attachment',
      name: counted ? counted[1] : label,
      count: counted ? counted[2] : null,
      detail: counted ? counted[2] : null,
      where: null,
      preview: attachment ? [`${attachment.kind === 'folder' ? 'At' : 'Saved at'} ${attachment.path}`] : [],
      moreLines: 0,
      lines: attachment ? [attachment.path] : [],
      target: null,
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
      firstLine: start ?? 1,
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
      target:
        quote.trim() || input.source
          ? {
              type: 'message',
              role: kind === 'you' ? 'user' : 'assistant',
              quote: quote.trim(),
              source: input.source ?? null,
            }
          : null,
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
    target: number ? { type: 'review', number: Number(number[1]), repo: parsed.repo ?? null } : null,
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
    // A composer attachment: its saved-path line.
    const attached = (/^(.*) \([\d,]+ (?:pages?|files?|lines?)\)$/.exec(label)?.[1] ?? label).replace(/\/$/, '')
    const line = new RegExp(
      `^\\[Attached (?:file|folder) "${escapeRegExp(attached)}" is (?:saved )?at: .+\\]$`,
      'm',
    ).exec(text)
    if (line) return line[0]
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

/** A terminal line the viewer tints as an error: an error word, or an HTTP 5xx status in a request log. */
export function isErrorLine(line: string): boolean {
  return /\b(error|errors|fatal|failed|failure|panic|exception)\b|\b5\d\d in \d/i.test(line)
}
