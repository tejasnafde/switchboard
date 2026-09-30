import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOwnedRunRoot, logFilesFromRun, RUN_ROOT_PREFIX } from './private-home'

/**
 * Gives the whole vitest run a throwaway home and data dir, so nothing the app
 * derives from os.homedir() or userDataDir() (logs, data/switchboard.db,
 * shell/.zshrc, worktrees/) lands in the real ~/.switchboard. Workers inherit
 * this env when they spawn. Teardown fails the run if a worker still wrote a
 * log file into the real home, then removes the run root.
 */
export default function setup(): () => void {
  const startedAt = Date.now()
  const realHome = homedir()
  const tmpRoot = realpathSync(tmpdir())
  const root = mkdtempSync(join(tmpRoot, RUN_ROOT_PREFIX))
  const home = join(root, 'home')
  const dataDir = join(root, 'switchboard-data')
  mkdirSync(home)
  mkdirSync(join(root, 'pids'))

  process.env.SB_TEST_REAL_HOME = realHome
  process.env.SB_TEST_RUN_ROOT = root
  process.env.SWITCHBOARD_DATA_DIR = dataDir
  process.env.HOME = home
  process.env.USERPROFILE = home

  return () => {
    const pids = new Set([process.pid, ...readdirSync(join(root, 'pids')).map(Number)])
    const realLogs = join(realHome, '.switchboard', 'logs')
    // Another process may prune a log between readdir and stat; that file is gone, not leaked.
    const entries = existsSync(realLogs)
      ? readdirSync(realLogs).flatMap((name) => {
          const stat = statSync(join(realLogs, name), { throwIfNoEntry: false })
          return stat ? [{ name, mtimeMs: stat.mtimeMs }] : []
        })
      : []
    const leaked = logFilesFromRun(entries, pids, startedAt)
    if (isOwnedRunRoot(root, tmpRoot)) rmSync(root, { recursive: true, force: true })
    if (leaked.length > 0) {
      throw new Error(`tests wrote ${leaked.length} log file(s) into ${realLogs}: ${leaked.slice(0, 5).join(', ')}`)
    }
  }
}
