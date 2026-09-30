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

/** Every variable the setup overrides; teardown puts each one back. */
export const PRIVATE_HOME_ENV_KEYS = [
  'SB_TEST_REAL_HOME',
  'SB_TEST_RUN_ROOT',
  'SWITCHBOARD_DATA_DIR',
  'HOME',
  'USERPROFILE',
] as const

export type EnvSnapshot = Record<string, string | undefined>

export function snapshotEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): EnvSnapshot {
  return Object.fromEntries(keys.map((key) => [key, env[key]]))
}

/** Puts every key back, deleting the ones that were unset. */
export function restoreEnv(env: NodeJS.ProcessEnv, snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
}

/**
 * The developer's home, even when a setup runs again before the last one was
 * torn down: HOME then already points at a private home, and only
 * SB_TEST_REAL_HOME still names the real one.
 */
export function resolveRealHome(env: NodeJS.ProcessEnv, currentHome: string): string {
  return env.SB_TEST_REAL_HOME || currentHome
}
