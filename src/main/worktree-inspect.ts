/**
 * What the worktree manager shows about each worktree: its git state (what
 * removing it would lose) and its size on disk.
 *
 * Git state is read at inventory time and again at removal time, so a
 * removal is judged on what is there now. Size is slow on a worktree with
 * node_modules, so it is computed lazily per row, in a child process (`du`)
 * off the main process's event loop, cached, and deduplicated in flight.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeInfo } from '@shared/kanban'
import type { WorktreeGitState } from '@shared/worktree-manager'
import type { GitRunner } from './worktree'
import { createMainLogger } from './logger'

const log = createMainLogger('worktree:inspect')
const execFileP = promisify(execFile)

const defaultRunner: GitRunner = async (args, cwd) => {
  const res = await execFileP('git', args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
  return { stdout: res.stdout, stderr: res.stderr }
}

function exitCode(err: unknown): unknown {
  return err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined
}

/**
 * The branch "merged" is measured against: origin's default branch, else a
 * local main or master, else whatever the main checkout has out.
 */
export async function resolveBaseRef(repoPath: string, runner: GitRunner = defaultRunner): Promise<string> {
  try {
    const { stdout } = await runner(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath)
    if (stdout.trim()) return stdout.trim()
  } catch (err) {
    log.debug(`no origin/HEAD in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (const candidate of ['refs/heads/main', 'refs/heads/master']) {
    try {
      await runner(['rev-parse', '--verify', '--quiet', candidate], repoPath)
      return candidate
    } catch (err) {
      log.debug(`${candidate} missing in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return 'HEAD'
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (err) {
    log.debug(`worktree dir missing: ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * Throws when git cannot answer; the caller records the row as unknown,
 * which is never offered for removal.
 */
export async function inspectWorktreeGit(
  repoPath: string,
  wt: Pick<WorktreeInfo, 'path' | 'head' | 'branch' | 'prunable'>,
  baseRef: string,
  runner: GitRunner = defaultRunner,
): Promise<WorktreeGitState> {
  let uncommittedFiles = 0
  if (!wt.prunable && await isDirectory(wt.path)) {
    const { stdout } = await runner(['status', '--porcelain'], wt.path)
    uncommittedFiles = stdout.split('\n').filter((line) => line.trim() !== '').length
  }

  // Commits reachable from this HEAD and from no other branch or remote:
  // exactly what is gone if the worktree and its branch both go.
  const revList = ['rev-list', '--count', wt.head, '--not']
  if (wt.branch) revList.push(`--exclude=${wt.branch}`)
  revList.push('--branches', '--remotes')
  const { stdout: count } = await runner(revList, repoPath)
  const unpushedCommits = Number.parseInt(count.trim(), 10)
  if (!Number.isFinite(unpushedCommits)) throw new Error(`unexpected rev-list output: ${count.trim()}`)

  let merged = false
  try {
    await runner(['merge-base', '--is-ancestor', wt.head, baseRef], repoPath)
    merged = true
  } catch (err) {
    // Exit 1 is git's "not an ancestor"; anything else is a real failure.
    if (exitCode(err) !== 1) throw err
  }
  return { uncommittedFiles, unpushedCommits, merged }
}

// ─── Size on disk ────────────────────────────────────────────────────

export type SizeProbe = (path: string) => Promise<number>

const duProbe: SizeProbe = async (path) => {
  // -k for a portable unit; -x stays on one filesystem so a mount inside the
  // worktree is not counted.
  const { stdout } = await execFileP('du', ['-skx', path], { timeout: 120_000, maxBuffer: 1024 * 1024 })
  const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10)
  if (!Number.isFinite(kb)) throw new Error(`unexpected du output: ${stdout.trim()}`)
  return kb * 1024
}

/** Windows has no `du`. Async, so it yields to the event loop between entries. */
const walkProbe: SizeProbe = async (root) => {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      log.debug(`size walk skipped ${dir}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          total += (await lstat(full)).size
        } catch (err) {
          log.debug(`size walk could not stat ${full}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }
  return total
}

export const SIZE_CACHE_TTL_MS = 10 * 60_000
const MAX_CONCURRENT_PROBES = 2

/**
 * Cached, in-flight-deduplicated size lookups with at most two probes
 * running at once, so opening a page of fifty worktrees does not start
 * fifty `du` processes.
 */
export class WorktreeSizeCache {
  private readonly cache = new Map<string, { bytes: number; at: number }>()
  private readonly inFlight = new Map<string, Promise<number | null>>()
  private readonly waiting: Array<() => void> = []
  private running = 0

  constructor(
    private readonly probe: SizeProbe = process.platform === 'win32' ? walkProbe : duProbe,
    private readonly now: () => number = Date.now,
  ) {}

  async get(path: string, opts: { refresh?: boolean } = {}): Promise<number | null> {
    const hit = this.cache.get(path)
    if (hit && !opts.refresh && this.now() - hit.at < SIZE_CACHE_TTL_MS) return hit.bytes
    const pending = this.inFlight.get(path)
    if (pending) return pending
    const run = this.measure(path).finally(() => this.inFlight.delete(path))
    this.inFlight.set(path, run)
    return run
  }

  invalidate(path: string): void {
    this.cache.delete(path)
  }

  private async measure(path: string): Promise<number | null> {
    if (this.running >= MAX_CONCURRENT_PROBES) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running += 1
    try {
      const bytes = await this.probe(path)
      this.cache.set(path, { bytes, at: this.now() })
      return bytes
    } catch (err) {
      log.warn(`size probe failed for ${path}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      this.running -= 1
      this.waiting.shift()?.()
    }
  }
}
