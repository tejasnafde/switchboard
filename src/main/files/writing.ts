/**
 * Atomic, EOL-aware, mtime-safe file write for the editor's save flow.
 *
 *   - Sniff the existing file's line endings; preserve them on write
 *     (caller hands us LF-normalized content because that's what
 *     CodeMirror produces).
 *   - Atomic via `write to .tmp + rename` so a partial write never
 *     leaves the user with a half-truncated source file.
 *   - mtime-conflict detection: if `expectedMtimeMs` is supplied and
 *     the on-disk stat reports a newer mtime, refuse with
 *     `conflict: true` so the renderer can show "External edits
 *     detected — reload?" UX. Mirror's t3code's optimistic-concurrency
 *     pattern.
 *
 * Cross-platform: every path operation goes through `node:path` and
 * `node:fs/promises`. Atomic rename works the same on POSIX and NTFS.
 */
import { promises as fs } from 'node:fs'

export interface WriteOptions {
  /**
   * The mtime the buffer last saw. If the on-disk file has a newer
   * mtime than this, the write is rejected with `conflict: true`.
   * Omit on initial create / first save of a new file.
   */
  expectedMtimeMs?: number
}

export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; error: string; conflict?: boolean }

async function detectEol(absPath: string): Promise<'\r\n' | '\n'> {
  try {
    const buf = await fs.readFile(absPath)
    // Look for the first '\n'. If preceded by '\r', file is CRLF.
    const idx = buf.indexOf(0x0a)
    if (idx > 0 && buf[idx - 1] === 0x0d) return '\r\n'
    return '\n'
  } catch {
    return '\n'
  }
}

function applyEol(content: string, eol: '\r\n' | '\n'): string {
  if (eol === '\n') return content
  // Caller hands us LF-normalized content; convert lone \n → \r\n,
  // leave existing \r\n alone (defensive).
  return content.replace(/\r?\n/g, '\r\n')
}

export async function writeFileSafe(
  absPath: string,
  content: string,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  // Existence + mtime check.
  let exists = false
  let currentMtimeMs = 0
  try {
    const stat = await fs.stat(absPath)
    exists = stat.isFile()
    currentMtimeMs = stat.mtimeMs
  } catch {
    // ENOENT — file doesn't exist; create-on-write path is fine.
  }

  if (exists && opts.expectedMtimeMs !== undefined && currentMtimeMs > opts.expectedMtimeMs) {
    return { ok: false, error: 'File changed on disk since open', conflict: true }
  }

  const eol = exists ? await detectEol(absPath) : '\n'
  const finalContent = applyEol(content, eol)

  const tmp = `${absPath}.sb-tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, finalContent, 'utf8')
    await fs.rename(tmp, absPath)
  } catch (err) {
    // Best-effort cleanup of the .tmp file on failure
    try { await fs.unlink(tmp) } catch { /* ignore */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const newStat = await fs.stat(absPath)
  return { ok: true, mtimeMs: newStat.mtimeMs }
}
