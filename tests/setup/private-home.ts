import { basename, dirname, resolve } from 'node:path'

/**
 * Pure rules behind the vitest private home (`global-private-home.ts`).
 * Kept apart from the setup so they can be unit-tested without a run.
 */

export const RUN_ROOT_PREFIX = 'sb-vitest-home-'

/** Only a directory this setup created, directly under the temp root, may be removed. */
export function isOwnedRunRoot(path: string, tmpRoot: string): boolean {
  const target = resolve(path)
  return dirname(target) === resolve(tmpRoot) && basename(target).startsWith(RUN_ROOT_PREFIX)
}

const LOG_FILE = /^switchboard-.*-(\d+)\.log$/

export interface LogFileEntry {
  name: string
  mtimeMs: number
}

/**
 * Log files written since the run started under one of its worker pids. The
 * mtime check matters because pids are reused: an older run's file can carry
 * the same pid.
 */
export function logFilesFromRun(
  entries: readonly LogFileEntry[],
  pids: ReadonlySet<number>,
  sinceMs: number,
): string[] {
  return entries
    .filter(({ name, mtimeMs }) => {
      const match = LOG_FILE.exec(name)
      return match !== null && pids.has(Number(match[1])) && mtimeMs >= sinceMs
    })
    .map(({ name }) => name)
}
