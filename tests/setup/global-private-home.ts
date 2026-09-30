import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isOwnedRunRoot,
  logFilesFromRun,
  PRIVATE_HOME_ENV_KEYS,
  resolveRealHome,
  restoreEnv,
  RUN_ROOT_PREFIX,
  snapshotEnv,
  type LogFileEntry,
} from './private-home'

function readLogDir(dir: string): LogFileEntry[] {
  if (!existsSync(dir)) return []
  // Another process may prune a log between readdir and stat; that file is gone, not leaked.
  return readdirSync(dir).flatMap((name) => {
    const stat = statSync(join(dir, name), { throwIfNoEntry: false })
    return stat ? [{ name, mtimeMs: stat.mtimeMs }] : []
  })
}

export interface PrivateHomeOptions {
  /** Lists the real home's log dir; injectable so a failing read can be tested. */
  readLogs?: (dir: string) => LogFileEntry[]
  /** Removes the run root; injectable so a failing removal can be tested. */
  removeDir?: (dir: string) => void
}

/**
 * Points HOME, USERPROFILE and SWITCHBOARD_DATA_DIR at a new run root under the
 * OS temp folder and returns the teardown. The teardown fails if a worker of
 * this run wrote a log file into the real ~/.switchboard/logs, and always
 * removes the run root and restores the env, so a watch-mode restart starts
 * again from the real home.
 */
export function startPrivateHome({
  readLogs = readLogDir,
  removeDir = (dir) => rmSync(dir, { recursive: true, force: true }),
}: PrivateHomeOptions = {}): () => void {
  const startedAt = Date.now()
  const realHome = resolveRealHome(process.env, homedir())
  const tmpRoot = realpathSync(tmpdir())
  const root = mkdtempSync(join(tmpRoot, RUN_ROOT_PREFIX))
  const home = join(root, 'home')
  mkdirSync(home)
  mkdirSync(join(root, 'pids'))

  const previousEnv = snapshotEnv(process.env, PRIVATE_HOME_ENV_KEYS)
  process.env.SB_TEST_REAL_HOME = realHome
  process.env.SB_TEST_RUN_ROOT = root
  process.env.SWITCHBOARD_DATA_DIR = join(root, 'switchboard-data')
  process.env.HOME = home
  process.env.USERPROFILE = home

  return () => {
    try {
      const pids = new Set([process.pid, ...readdirSync(join(root, 'pids')).map(Number)])
      const realLogs = join(realHome, '.switchboard', 'logs')
      const leaked = logFilesFromRun(readLogs(realLogs), pids, startedAt)
      if (leaked.length > 0) {
        throw new Error(`tests wrote ${leaked.length} log file(s) into ${realLogs}: ${leaked.slice(0, 5).join(', ')}`)
      }
    } finally {
      // Restore even when the removal throws (EPERM, EBUSY): force only covers a missing path.
      try {
        if (isOwnedRunRoot(root, tmpRoot)) removeDir(root)
      } finally {
        restoreEnv(process.env, previousEnv)
      }
    }
  }
}

/**
 * Vitest globalSetup: the whole run gets a throwaway home and data dir, so
 * nothing the app derives from os.homedir() or userDataDir() (logs,
 * data/switchboard.db, shell/.zshrc, worktrees/) lands in the real
 * ~/.switchboard. Workers inherit this env when they spawn.
 */
export default function setup(): () => void {
  return startPrivateHome()
}
