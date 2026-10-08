/**
 * Replace a file's content by writing a temp file and renaming it over the
 * target, so a reader never sees half a file.
 *
 * On Windows the rename fails with EPERM, EACCES or EBUSY while another
 * process has the target open (an editor, antivirus, a concurrent read).
 * That lock is usually released within milliseconds, so the rename is
 * retried with a short backoff (about 500 ms in all, like graceful-fs). If
 * the target stays locked, the temp file is removed, the target is left as
 * it was and the lock error is thrown. There is no in-place fallback:
 * writing the target directly truncates it first, so a write that then
 * fails leaves only a prefix, and a damaged file is worse than a failed save.
 *
 * The caller checks the target before calling, but a retry happens later,
 * and an editor may have saved in between. `stillSafe` is asked again before
 * each retried rename; when it answers false the
 * target is left alone and `TargetChangedError` is thrown. One stat and one
 * rename apart, a gap remains that only a lock could close: neither POSIX
 * nor NTFS has an atomic compare-and-rename, and editors ignore advisory locks.
 *
 * Electron-free, with fs and the clock injectable, for the tests.
 */
import { rename, unlink, writeFile } from 'node:fs/promises'

export interface ReplaceFileLog {
  warn(...args: unknown[]): void
}

export interface ReplaceFileOps {
  writeFile: (path: string, content: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  unlink: (path: string) => Promise<void>
}

export interface ReplaceFileOptions {
  log: ReplaceFileLog
  /** Defaults to `<target>.tmp`. */
  tmp?: string
  ops?: ReplaceFileOps
  sleep?: (ms: number) => Promise<void>
  /** Whether the target may still be replaced; asked before each retried rename. */
  stillSafe?: () => Promise<boolean>
}

export class TargetChangedError extends Error {
  constructor(readonly target: string) {
    super(`${target} changed while its replacement waited for a lock`)
    this.name = 'TargetChangedError'
  }
}

/** Waits before each retry of the rename: 5 tries over 500 ms. */
export const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200]

const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

const defaultOps: ReplaceFileOps = {
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  rename,
  unlink,
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isLocked = (err: unknown): boolean => LOCKED_CODES.has((err as NodeJS.ErrnoException)?.code ?? '')

export async function replaceFile(target: string, content: string, opts: ReplaceFileOptions): Promise<void> {
  const { log, tmp = `${target}.tmp`, ops = defaultOps, sleep = wait, stillSafe } = opts
  const ensureSafe = async () => {
    if (stillSafe && !(await stillSafe())) throw new TargetChangedError(target)
  }
  try {
    await ops.writeFile(tmp, content)
  } catch (err) {
    await removeTmp(tmp, ops, log)
    throw err
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await ops.rename(tmp, target)
        return
      } catch (err) {
        if (!isLocked(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
        const delay = RENAME_RETRY_DELAYS_MS[attempt]
        log.warn(
          `rename over ${target} failed (${(err as NodeJS.ErrnoException).code}), retry ${attempt + 1} of ${RENAME_RETRY_DELAYS_MS.length} in ${delay}ms`,
        )
        await sleep(delay)
        await ensureSafe()
      }
    }
  } catch (err) {
    await removeTmp(tmp, ops, log)
    if (isLocked(err))
      log.warn(`rename over ${target} still failing (${(err as NodeJS.ErrnoException).code}); left as it was`)
    throw err
  }
}

async function removeTmp(tmp: string, ops: ReplaceFileOps, log: ReplaceFileLog): Promise<void> {
  try {
    await ops.unlink(tmp)
  } catch (err) {
    // A tmp write that failed before creating the file leaves nothing to remove.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    log.warn(`could not remove ${tmp}`, err)
  }
}
