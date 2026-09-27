/**
 * `get_pr_diff` output: the changed files of a pull request as text an agent
 * can cite line numbers from, cut into pages under a byte cap. Pure.
 *
 * Whole files go on a page while they fit; a file too big for what is left
 * starts the next page, and a file bigger than a page is split between hunks,
 * then between lines. Every page after the first repeats the header of the
 * file it continues. The footer says which page this is, which files the
 * other pages hold, and what to call next.
 */
import type { DiffHunk, PrChangedFile } from '@shared/pull-requests'

/** What one `get_pr_diff` call returns at most, footer included. */
export const PR_DIFF_PAGE_BYTES = 60 * 1024
/** Kept back from the page for the footer. */
const FOOTER_BYTES = 4 * 1024
/** A longer diff line (minified code, a lockfile) is cut; the host has the rest. */
export const PR_DIFF_LINE_CHARS = 400
/** Room for each list of file names in the footer before it says "and N more". */
const FOOTER_LIST_BYTES = 1_200
/** Longer filters are refused: a path filter is a path. */
const FILTER_MAX_CHARS = 1_000

const utf8 = new TextEncoder()
const bytes = (text: string): number => utf8.encode(text).length

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
  const renamed = f.oldPath && f.oldPath !== f.path ? `, renamed from ${f.oldPath}` : ''
  return `=== ${f.path} (${f.status}${renamed}, +${f.additions} -${f.deletions})${continued ? ' (continued)' : ''}\n`
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
    let block: Block = { file: f, text: `${hunk.header}\n`, cut: 0 }
    let size = bytes(block.text)
    for (const l of hunk.lines) {
      const line = lineText(l, width)
      const lineBytes = bytes(line.text)
      if (size + lineBytes > budget) {
        blocks.push(block)
        block = { file: f, text: `${hunk.header} (continued)\n`, cut: 0 }
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

function namesList(names: string[]): string {
  const listed: string[] = []
  let used = 0
  for (const name of names) {
    used += bytes(name) + 2
    if (used > FOOTER_LIST_BYTES) break
    listed.push(name)
  }
  const rest = names.length - listed.length
  if (rest === 0) return listed.join(', ')
  return listed.length > 0 ? `${listed.join(', ')} and ${rest} more` : `${rest} files`
}

export function diffPage(files: readonly PrChangedFile[], req: DiffPageRequest, pageBytes = PR_DIFF_PAGE_BYTES): DiffPageResult {
  const filter = req.path?.trim() ?? ''
  if (filter.length > FILTER_MAX_CHARS) return { ok: false, message: '"path" is a file or directory path of the diff.' }
  const shown = filter ? files.filter((f) => matchesPathFilter(f, filter)) : [...files]
  if (shown.length === 0) {
    if (files.length === 0) return { ok: true, text: 'This pull request changes no files.', page: 1, pages: 1 }
    return { ok: false, message: `No changed file matches "${filter}". Changed files: ${namesList(files.map((f) => f.path))}.` }
  }

  const budget = pageBytes - FOOTER_BYTES
  const pages: Block[][] = [[]]
  let used = bytes(req.heading) + bytes(HOW_TO_READ) + 3
  for (const f of shown) {
    // Room for a "(continued)" header on the page a split file carries on to.
    const blocks = fileBlocks(f, budget - 512)
    const whole = blocks.reduce((n, b) => n + bytes(b.text), 0)
    blocks.forEach((block, i) => {
      const size = bytes(block.text)
      // A file that fits on a page of its own is never split: it starts the next page instead.
      const need = i === 0 && whole <= budget ? whole : size
      if (pages[pages.length - 1].length > 0 && used + need > budget) {
        const next: Block[] = i === 0 ? [] : [{ file: f, text: fileHeader(f, true), cut: 0 }]
        pages.push(next)
        used = bytes(req.heading) + 1 + next.reduce((n, b) => n + bytes(b.text), 0)
      }
      pages[pages.length - 1].push(block)
      used += size
    })
  }

  const total = pages.length
  const page = req.page ?? 1
  if (!Number.isInteger(page) || page < 1 || page > total) {
    return { ok: false, message: `There ${total === 1 ? 'is 1 page' : `are ${total} pages`}${filter ? ` for "${filter}"` : ''}; page ${String(req.page)} does not exist.` }
  }

  const blocks = pages[page - 1]
  const leftOut = [...new Set(pages.flatMap((p, i) => (i === page - 1 ? [] : p.map((b) => b.file.path))))]
  const cut = blocks.reduce((n, b) => n + b.cut, 0)
  const footer: string[] = [`--- Page ${page} of ${total}${filter ? ` for "${filter}"` : ''}. ${shown.length} of ${files.length} changed files match.`]
  if (leftOut.length > 0) footer.push(`On other pages (in whole or in part): ${namesList(leftOut)}.`)
  if (page < total) footer.push(`Next: call get_pr_diff with page: ${page + 1}${filter ? ' and the same path' : ''}.`)
  if (shown.length < files.length) footer.push(`Not matched by "${filter}": ${namesList(files.filter((f) => !shown.includes(f)).map((f) => f.path))}.`)
  if (cut > 0) footer.push(`${cut} ${cut === 1 ? 'line' : 'lines'} longer than ${PR_DIFF_LINE_CHARS} characters were cut.`)
  return { ok: true, text: `${req.heading}\n${page === 1 ? `${HOW_TO_READ}\n\n` : ''}${blocks.map((b) => b.text).join('')}\n${footer.join('\n')}`, page, pages: total }
}
