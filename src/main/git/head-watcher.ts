/**
 * Watches a repo's HEAD for checkout changes so the renderer's branch chip
 * updates on push instead of polling `git rev-parse` in a subprocess every
 * 5s per visible chip.
 *
 * Watches the resolved git dir DIRECTORY (not the HEAD file itself - git
 * updates HEAD via rename, which detaches file-level watchers) and filters
 * for HEAD events, debounced 50ms (checkout touches HEAD more than once).
 * `rev-parse --absolute-git-dir` resolves worktrees, whose `.git` is a
 * pointer file. Watchers are refcounted per cwd; last unwatch closes.
 */
import { watch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMainLogger } from '../logger'

const execFileP = promisify(execFile)
const log = createMainLogger('git:head-watcher')

interface WatchEntry {
  refs: number
  watcher: FSWatcher | null
  debounce: ReturnType<typeof setTimeout> | null
  /** Set when the last unwatch raced the async setup. */
  closed: boolean
}

// ponytail: refs only decrement via UNWATCH_HEAD from renderer effect
// cleanup, so an abnormal teardown (ws drop, force-close) leaks the entry.
// Bounded at one FSWatcher per distinct repo path; per-connection GC on the
// backend host is the upgrade if remote servers accumulate watchers.
const entries = new Map<string, WatchEntry>()

export async function watchHead(cwd: string, onChange: (cwd: string) => void): Promise<void> {
  const existing = entries.get(cwd)
  if (existing) {
    existing.refs += 1
    return
  }
  const entry: WatchEntry = { refs: 1, watcher: null, debounce: null, closed: false }
  entries.set(cwd, entry)
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--absolute-git-dir'], {
      cwd,
      timeout: 5000,
    })
    const gitDir = stdout.trim()
    if (!gitDir || entry.closed) return
    entry.watcher = watch(gitDir, (_event, filename) => {
      if (filename !== 'HEAD') return
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(() => {
        entry.debounce = null
        onChange(cwd)
      }, 50)
    })
    entry.watcher.on('error', (err) => log.warn('head watcher error', { cwd, err }))
  } catch (err) {
    // Not a repo / git missing: entry stays (refcount must balance the
    // renderer's unwatch) but no watcher is attached.
    log.debug('watch-head setup skipped', { cwd, err: err instanceof Error ? err.message : String(err) })
  }
}

export function unwatchHead(cwd: string): void {
  const entry = entries.get(cwd)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  entries.delete(cwd)
  entry.closed = true
  if (entry.debounce) clearTimeout(entry.debounce)
  entry.watcher?.close()
}

/** Test seam / shutdown. */
export function closeAllHeadWatchers(): void {
  for (const entry of entries.values()) {
    entry.closed = true
    if (entry.debounce) clearTimeout(entry.debounce)
    entry.watcher?.close()
  }
  entries.clear()
}
