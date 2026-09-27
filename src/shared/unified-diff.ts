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

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * Git C-quotes a path with unusual bytes: `"a/dir/na\303\257ve.py"`, octal
 * escapes for each UTF-8 byte plus `\"`, `\\` and `\t`-style escapes. An
 * unquoted path is returned as is, so a literal backslash in it stays.
 */
export function unquoteGitPath(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path
  const body = path.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\' || i === body.length - 1) {
      bytes.push(...new TextEncoder().encode(ch))
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += 3
    } else if (body[i + 1] in C_ESCAPES) {
      bytes.push(C_ESCAPES[body[i + 1]])
      i += 1
    } else {
      bytes.push(92)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function stripPrefix(path: string): string | null {
  const p = unquoteGitPath(path.trim())
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

/** Cut a multi-file `git diff` into files. Paths come from the ---/+++ lines, falling back to the `diff --git` line. */
export function splitGitDiff(text: string): GitDiffFile[] {
  const files: GitDiffFile[] = []
  const chunks = toLf(text).split(/^diff --git /m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    // Either side of the header may be C-quoted on its own.
    const head = /^("(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(lines[0] ?? '')
    let oldPath: string | null = head ? stripPrefix(head[1]) : null
    let newPath: string | null = head ? stripPrefix(head[2]) : null
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
