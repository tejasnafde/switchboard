/**
 * `get_pr_diff` output: the changed files of a pull request as text an agent
 * can cite line numbers from, cut into pages under a byte cap. Pure.
 *
 * Whole files go on a page while they fit; a file too big for what is left
 * starts the next page, and a file bigger than a page is split between hunks,
 * then between lines. Every page after the first repeats the header of the
 * file it continues. The footer says which page this is, which files the
 * other pages hold, and what to call next.
 *
 * The cap is a hard bound in UTF-8 bytes: paths and hunk headers from the
 * host are clipped, the room kept for the footer is the byte size of the
 * largest footer this diff can render, and a hunk is split small enough to
 * fit on a page after that page's heading and its "(continued)" header.
 */
import type { DiffHunk, PrChangedFile } from '@shared/pull-requests'

/** What one `get_pr_diff` call returns at most, footer included. */
export const PR_DIFF_PAGE_BYTES = 60 * 1024
/** A longer diff line (minified code, a lockfile) is cut; the host has the rest. */
export const PR_DIFF_LINE_CHARS = 400
/** Each list of file names in the footer, "and N more" included. */
const FOOTER_LIST_BYTES = 1_200
/** Longer filters are refused: a path filter is a path. */
const FILTER_MAX_BYTES = 1_000
/** A path, an old path or a filter as the page shows it; a longer one is cut in the middle of nothing but the page. */
const PATH_SHOWN_BYTES = 300
/** A hunk header or the heading as the page shows it. */
const HEADER_SHOWN_BYTES = 300

const utf8 = new TextEncoder()
const bytes = (text: string): number => utf8.encode(text).length

/** `text` cut to at most `max` UTF-8 bytes, on a code point boundary, ending in "…" when cut. */
export function clipBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  let out = ''
  let used = bytes('…')
  for (const ch of text) {
    const size = bytes(ch)
    if (used + size > max) break
    out += ch
    used += size
  }
  return `${out}…`
}

const shownPath = (path: string): string => clipBytes(path, PATH_SHOWN_BYTES)

export interface DiffPageRequest {
  /** The first line of every page: which pull request this is. */
  heading: string
  /** A file path, or a directory: every file under it. */
  path?: string
  /** 1-based. */
  page?: number
}

export type DiffPageResult = { ok: true; text: string; page: number; pages: number } | { ok: false; message: string }

export function matchesPathFilter(file: Pick<PrChangedFile, 'path' | 'oldPath'>, filter: string): boolean {
  const dir = filter.replace(/\/+$/, '')
  if (!dir) return true
  return [file.path, file.oldPath].some((p) => p !== null && (p === dir || p.startsWith(`${dir}/`)))
}

function fileHeader(f: PrChangedFile, continued: boolean): string {
  const renamed = f.oldPath && f.oldPath !== f.path ? `, renamed from ${shownPath(f.oldPath)}` : ''
  return `=== ${shownPath(f.path)} (${f.status}${renamed}, +${f.additions} -${f.deletions})${continued ? ' (continued)' : ''}\n`
}

function lineText(l: DiffHunk['lines'][number], width: number): { text: string; cut: boolean } {
  const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
  const oldCol = (l.oldLine === null ? '' : String(l.oldLine)).padStart(width)
  const newCol = (l.newLine === null ? '' : String(l.newLine)).padStart(width)
  const cut = l.text.length > PR_DIFF_LINE_CHARS
  const body = cut ? `${l.text.slice(0, PR_DIFF_LINE_CHARS)}… (line cut)` : l.text
  return { text: `${mark}${oldCol} ${newCol} | ${body}\n`, cut }
}

interface Block {
  file: PrChangedFile
  text: string
  /** Diff lines in this block cut at PR_DIFF_LINE_CHARS. */
  cut: number
}

/** A file as a header block, then one block per hunk (per run of lines for a hunk bigger than `budget`). */
function fileBlocks(f: PrChangedFile, budget: number): Block[] {
  let head = fileHeader(f, false)
  if (f.binary) head += '(binary file, no diff)\n'
  else if (f.hunks.length === 0) head += '(no diff lines: a rename or a mode change)\n'
  if (f.truncated) head += '(the host cut this patch short; the rest is only on the host)\n'
  const blocks: Block[] = [{ file: f, text: head, cut: 0 }]
  if (f.binary) return blocks
  const width = Math.max(1, ...f.hunks.flatMap((h) => h.lines.flatMap((l) => [l.oldLine ?? 0, l.newLine ?? 0])).map((n) => String(n).length))
  for (const hunk of f.hunks) {
    const header = clipBytes(hunk.header, HEADER_SHOWN_BYTES)
    let block: Block = { file: f, text: `${header}\n`, cut: 0 }
    let size = bytes(block.text)
    for (const l of hunk.lines) {
      const line = lineText(l, width)
      const lineBytes = bytes(line.text)
      if (size + lineBytes > budget) {
        blocks.push(block)
        block = { file: f, text: `${header} (continued)\n`, cut: 0 }
        size = bytes(block.text)
      }
      block.text += line.text
      size += lineBytes
      if (line.cut) block.cut++
    }
    blocks.push(block)
  }
  return blocks
}

const HOW_TO_READ = [
  'Columns: old line, new line, then the text. "+" added, "-" deleted, " " unchanged.',
  'To comment, use side "new" with the new line number (added or unchanged lines), or side "old" with the old line number (deleted lines).',
].join('\n')

/** Names in order while they fit in FOOTER_LIST_BYTES, then "and N more". */
function namesList(names: string[]): string {
  const shown = names.map(shownPath)
  for (let n = shown.length; n >= 0; n--) {
    const rest = shown.length - n
    const text = `${shown.slice(0, n).join(', ')}${rest === 0 ? '' : n > 0 ? ` and ${rest} more` : `${rest} files`}`
    if (bytes(text) <= FOOTER_LIST_BYTES) return text
  }
  return `${shown.length} files`
}

interface FooterFacts {
  page: number
  total: number
  /** The filter as the page shows it, '' for none. */
  filter: string
  matched: number
  files: number
  leftOut: string
  unmatched: string
  cut: number
}

function renderFooter(f: FooterFacts): string {
  const lines = [`--- Page ${f.page} of ${f.total}${f.filter ? ` for "${f.filter}"` : ''}. ${f.matched} of ${f.files} changed files match.`]
  if (f.leftOut) lines.push(`On other pages (in whole or in part): ${f.leftOut}.`)
  if (f.page < f.total) lines.push(`Next: call get_pr_diff with page: ${f.page + 1}${f.filter ? ' and the same path' : ''}.`)
  if (f.unmatched) lines.push(`Not matched by "${f.filter}": ${f.unmatched}.`)
  if (f.cut > 0) lines.push(`${f.cut} ${f.cut === 1 ? 'line' : 'lines'} longer than ${PR_DIFF_LINE_CHARS} characters were cut.`)
  return lines.join('\n')
}

export function diffPage(files: readonly PrChangedFile[], req: DiffPageRequest, pageBytes = PR_DIFF_PAGE_BYTES): DiffPageResult {
  const filter = req.path?.trim() ?? ''
  if (bytes(filter) > FILTER_MAX_BYTES) return { ok: false, message: '"path" is a file or directory path of the diff.' }
  const shown = filter ? files.filter((f) => matchesPathFilter(f, filter)) : [...files]
  if (shown.length === 0) {
    if (files.length === 0) return { ok: true, text: 'This pull request changes no files.', page: 1, pages: 1 }
    return { ok: false, message: `No changed file matches "${shownPath(filter)}". Changed files: ${namesList(files.map((f) => f.path))}.` }
  }

  const heading = `${clipBytes(req.heading, HEADER_SHOWN_BYTES)}\n`
  const intro = `${HOW_TO_READ}\n\n`
  const shownFilter = filter ? shownPath(filter) : ''
  const unmatched = shown.length < files.length ? namesList(files.filter((f) => !shown.includes(f)).map((f) => f.path)) : ''
  const lineCount = shown.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0)
  // No more pages than blocks: a header per file, at most one block per line or per empty hunk.
  const maxPages = shown.length + lineCount + shown.reduce((n, f) => n + f.hunks.length, 0)
  // The largest footer this diff can render: page numbers and the cut count at
  // their widest, a full list of the files on other pages. Plus the newline before it.
  const footerRoom = 1 + bytes(renderFooter({
    page: maxPages,
    total: maxPages + 1,
    filter: shownFilter,
    matched: shown.length,
    files: files.length,
    leftOut: 'x'.repeat(FOOTER_LIST_BYTES),
    unmatched,
    cut: lineCount,
  }))
  const budget = pageBytes - footerRoom
  const pages: Block[][] = [[]]
  let used = bytes(heading) + bytes(intro)
  for (const f of shown) {
    const continued = fileHeader(f, true)
    // A hunk block must fit on a page of its own after the page's heading and
    // the "(continued)" header, or after the heading and the intro on page 1.
    const blockRoom = budget - bytes(heading) - Math.max(bytes(intro), bytes(continued))
    const blocks = fileBlocks(f, blockRoom)
    const whole = blocks.reduce((n, b) => n + bytes(b.text), 0)
    blocks.forEach((block, i) => {
      const size = bytes(block.text)
      // A file that fits on a page of its own is never split: it starts the next page instead.
      const need = i === 0 && whole <= budget - bytes(heading) ? whole : size
      if (pages[pages.length - 1].length > 0 && used + need > budget) {
        const next: Block[] = i === 0 ? [] : [{ file: f, text: continued, cut: 0 }]
        pages.push(next)
        used = bytes(heading) + next.reduce((n, b) => n + bytes(b.text), 0)
      }
      pages[pages.length - 1].push(block)
      used += size
    })
  }

  const total = pages.length
  const page = req.page ?? 1
  if (!Number.isInteger(page) || page < 1 || page > total) {
    return { ok: false, message: `There ${total === 1 ? 'is 1 page' : `are ${total} pages`}${shownFilter ? ` for "${shownFilter}"` : ''}; page ${String(req.page)} does not exist.` }
  }

  const blocks = pages[page - 1]
  const leftOut = [...new Set(pages.flatMap((p, i) => (i === page - 1 ? [] : p.map((b) => b.file.path))))]
  const footer = renderFooter({
    page,
    total,
    filter: shownFilter,
    matched: shown.length,
    files: files.length,
    leftOut: leftOut.length > 0 ? namesList(leftOut) : '',
    unmatched,
    cut: blocks.reduce((n, b) => n + b.cut, 0),
  })
  return { ok: true, text: `${heading}${page === 1 ? intro : ''}${blocks.map((b) => b.text).join('')}\n${footer}`, page, pages: total }
}
