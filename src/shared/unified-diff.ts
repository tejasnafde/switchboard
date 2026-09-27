/**
 * Unified diff text -> hunks with line numbers, for the read-only pull
 * request diff. GitHub hands over one file's hunks (`patch`); Bitbucket hands
 * over a whole `git diff`, which `splitGitDiff` cuts into files first.
 */
import type { DiffHunk, DiffLine } from './pull-requests'

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** Lines kept per file; the rest of a huge file is on the host. */
export const MAX_DIFF_LINES_PER_FILE = 3000

export interface ParsedHunks {
  hunks: DiffHunk[]
  truncated: boolean
}

/** A server, a proxy or a Windows checkout can hand over CRLF; a stray CR would end up in every path and line. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function parseHunks(patch: string, maxLines = MAX_DIFF_LINES_PER_FILE): ParsedHunks {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let kept = 0
  for (const raw of toLf(patch).split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      if (kept >= maxLines) return { hunks, truncated: true }
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = { header: raw, oldStart: oldLine, newStart: newLine, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    const mark = raw[0]
    let line: DiffLine | null = null
    if (mark === '+') line = { kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ }
    else if (mark === '-') line = { kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null }
    else if (mark === ' ') line = { kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ }
    // "\ No newline at end of file" and the trailing empty split are not lines.
    if (!line) continue
    if (kept >= maxLines) return { hunks, truncated: true }
    current.lines.push(line)
    kept++
  }
  return { hunks, truncated: false }
}

export interface GitDiffFile {
  oldPath: string | null
  newPath: string | null
  binary: boolean
  patch: string
}

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

function stripPrefix(path: string): string | null {
  const p = unquote(path.trim())
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

/** Cut a multi-file `git diff` into files. Paths come from the ---/+++ lines, falling back to the `diff --git` line. */
export function splitGitDiff(text: string): GitDiffFile[] {
  const files: GitDiffFile[] = []
  const chunks = toLf(text).split(/^diff --git /m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const head = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(lines[0] ?? '')
    let oldPath: string | null = head?.[1] ?? null
    let newPath: string | null = head?.[2] ?? null
    let binary = false
    let bodyStart = lines.length
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]
      if (l.startsWith('--- ')) oldPath = stripPrefix(l.slice(4))
      else if (l.startsWith('+++ ')) newPath = stripPrefix(l.slice(4))
      else if (l.startsWith('new file mode')) oldPath = null
      else if (l.startsWith('deleted file mode')) newPath = null
      else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) binary = true
      else if (l.startsWith('@@')) {
        bodyStart = i
        break
      }
    }
    files.push({ oldPath, newPath, binary, patch: lines.slice(bodyStart).join('\n') })
  }
  return files
}
