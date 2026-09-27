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
 *     detected - reload?" UX. Mirror's t3code's optimistic-concurrency
 *     pattern.
 *
 * Cross-platform: every path operation goes through `node:path` and
 * `node:fs/promises`. The rename goes through `replaceFile`, which retries
 * it while Windows has the target locked.
 */
import { promises as fs } from 'node:fs'
import { createMainLogger } from '../logger'
import { TargetChangedError, replaceFile } from './replace-file'

const log = createMainLogger('files:writing')

export interface WriteOptions {
  /**
   * The mtime the buffer last saw. If the on-disk file has a newer
   * mtime than this, the write is rejected with `conflict: true`.
   * Omit on initial create / first save of a new file.
   */
  expectedMtimeMs?: number
  /**
   * What the file must hold now, or null for "must not exist". A diff card
   * reverting an agent's change passes the content the agent wrote, so a
   * card reopened after later edits cannot silently undo them.
   */
  expectedContent?: string | null
}

const CONFLICT_SINCE_OPEN = 'File changed on disk since open'
const CONFLICT_SINCE_DIFF = 'File changed on disk after the diff was captured'

/** Whether the file still holds `expected` (null = absent), ignoring line endings. */
async function holdsContent(absPath: string, expected: string | null): Promise<boolean> {
  let current: string
  try {
    current = await fs.readFile(absPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug('expected-content check: file absent', { absPath })
      return expected === null
    }
    throw err
  }
  return expected !== null && current.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n')
}

export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; error: string; conflict?: boolean }

async function detectEol(absPath: string): Promise<'\r\n' | '\n'> {
  try {
    const text = await fs.readFile(absPath, 'latin1')
    // Majority vote so a leading bare '\n' doesn't flip a CRLF file to LF.
    const crlf = (text.match(/\r\n/g) ?? []).length
    const lf = (text.match(/(^|[^\r])\n/g) ?? []).length
    return crlf > lf ? '\r\n' : '\n'
  } catch {
    return '\n'
  }
}

function applyEol(content: string, eol: '\r\n' | '\n'): string {
  if (eol === '\n') return content
  // Normalize any line ending to CRLF (a stray lone '\r' must not survive).
  return content.replace(/\r\n|\r|\n/g, '\r\n')
}

/** Why the write must not go ahead, or null. Asked before the write and again before a retry waiting on a Windows lock. */
async function conflictReason(absPath: string, opts: WriteOptions, stat: { exists: boolean; mtimeMs: number }): Promise<string | null> {
  if (stat.exists && opts.expectedMtimeMs !== undefined && stat.mtimeMs > opts.expectedMtimeMs) return CONFLICT_SINCE_OPEN
  if (opts.expectedContent !== undefined && !(await holdsContent(absPath, opts.expectedContent))) return CONFLICT_SINCE_DIFF
  return null
}

async function statTarget(absPath: string): Promise<{ exists: boolean; mtimeMs: number }> {
  try {
    const stat = await fs.stat(absPath)
    return { exists: stat.isFile(), mtimeMs: stat.mtimeMs }
  } catch (err) {
    // ENOENT - file doesn't exist; create-on-write path is fine.
    log.debug('stat failed before write, treating as new file', { absPath, err })
    return { exists: false, mtimeMs: 0 }
  }
}

export async function writeFileSafe(
  absPath: string,
  content: string,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const before = await statTarget(absPath)
  const conflict = await conflictReason(absPath, opts, before)
  if (conflict) return { ok: false, error: conflict, conflict: true }

  const eol = before.exists ? await detectEol(absPath) : '\n'
  const finalContent = applyEol(content, eol)

  let lateConflict: string | null = null
  const stillSafe = async () => {
    lateConflict = await conflictReason(absPath, opts, await statTarget(absPath))
    return lateConflict === null
  }
  const tmp = `${absPath}.sb-tmp-${process.pid}-${Date.now()}`
  try {
    await replaceFile(absPath, finalContent, { log, tmp, stillSafe })
  } catch (err) {
    if (err instanceof TargetChangedError && lateConflict) return { ok: false, error: lateConflict, conflict: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const newStat = await fs.stat(absPath)
  return { ok: true, mtimeMs: newStat.mtimeMs }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Delete a file. Used to truly revert an agent-*added* file from a diff card
 * (writing empty content would leave a stray empty file). A missing file is
 * treated as success - the desired end state (absent) already holds.
 */
export async function deleteFileSafe(absPath: string, expectedContent?: string): Promise<DeleteResult> {
  try {
    // Already absent is the state a delete wants, so only a changed file conflicts.
    if (expectedContent !== undefined && !(await holdsContent(absPath, expectedContent)) && !(await holdsContent(absPath, null))) {
      return { ok: false, error: CONFLICT_SINCE_DIFF }
    }
    await fs.unlink(absPath)
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
