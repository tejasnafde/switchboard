/**
 * Replace a file's content by writing a temp file and renaming it over the
 * target, so a reader never sees half a file.
 *
 * On Windows the rename fails with EPERM, EACCES or EBUSY while another
 * process has the target open (an editor, antivirus, a concurrent read).
 * That lock is usually released within milliseconds, so the rename is
 * retried with a short backoff (about 500 ms in all, like graceful-fs). If
 * the target stays locked, the content is written into it in place: not
 * atomic, but a locked file still accepts a write where it refuses a rename,
 * and losing the save is worse than a brief partial read.
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
  const { log, tmp = `${target}.tmp`, ops = defaultOps, sleep = wait } = opts
  await ops.writeFile(tmp, content)
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await ops.rename(tmp, target)
        return
      } catch (err) {
        if (!isLocked(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
        const delay = RENAME_RETRY_DELAYS_MS[attempt]
        log.warn(`rename over ${target} failed (${(err as NodeJS.ErrnoException).code}), retry ${attempt + 1} of ${RENAME_RETRY_DELAYS_MS.length} in ${delay}ms`)
        await sleep(delay)
      }
    }
  } catch (err) {
    await removeTmp(tmp, ops, log)
    if (!isLocked(err)) throw err
    log.warn(`rename over ${target} still failing (${(err as NodeJS.ErrnoException).code}); writing it in place`)
    await ops.writeFile(target, content)
  }
}

async function removeTmp(tmp: string, ops: ReplaceFileOps, log: ReplaceFileLog): Promise<void> {
  try {
    await ops.unlink(tmp)
  } catch (err) {
    log.warn(`could not remove ${tmp}`, err)
  }
}
