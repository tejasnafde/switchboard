/**
 * Git worktree listing/removal primitives for the kanban card ->
 * isolated workspace flow.
 *
 * Worktree *creation* used to live here too, but that path is dead:
 * kanban cards create worktrees through the transactional flow in
 * `src/main/worktree-creation/git-adapter.ts`, and session worktrees
 * through `src/main/git/legacy-session-worktree-lease.ts`. See AGENTS.md
 * "Git tooling + worktrees" for the map. This module now only lists,
 * finds stale, and removes worktrees - callers that still need the
 * underlying `git worktree` CLI semantics (locked worktrees, prunable
 * refs, dirty workdirs) for those operations.
 *
 * All functions shell out to the `git` CLI. We deliberately avoid
 * libgit2 / nodegit: git's worktree semantics are subtle, and the CLI's
 * behaviour is the canonical reference. Spawning a process per call is
 * fine - worktree ops happen at human pace, not in a hot loop.
 *
 * Pure-ish module: every fn takes paths + accepts an optional
 * `runner` for tests to inject a fake exec. Default runner uses
 * child_process.execFile with a 10s timeout.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createMainLogger } from './logger'
import type { WorktreeInfo } from '@shared/kanban'
import { protectionSource, type WorktreeProtection } from '@shared/worktree-manager'

const log = createMainLogger('worktree')
const execFileP = promisify(execFile)

/**
 * Test seam. Default runs `git` via execFile.  Tests pass a stub that
 * matches argv arrays to canned responses.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>

const defaultRunner: GitRunner = async (args, cwd) => {
  const res = await execFileP('git', args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
  return { stdout: res.stdout, stderr: res.stderr }
}

/**
 * Subdirectory under the project root where Switchboard parks per-card
 * worktrees. `.switchboard/` is also where we'd plausibly stash other
 * per-project artifacts later (recorded transcripts, kanban exports);
 * keeping a single namespaced dir avoids polluting the user's tree.
 */
export const WORKTREE_DIR_REL = '.switchboard/worktrees'

export function worktreeRootFor(repoPath: string): string {
  return join(repoPath, WORKTREE_DIR_REL)
}

/**
 * Remove a worktree.  Defaults to a safe remove (refuses if dirty);
 * pass `force=true` from cleanup flows where the user has explicitly
 * acknowledged data loss.
 *
 * Also deletes the branch the worktree was on, iff it matches our
 * `kanban/` prefix - leaves user-created branches alone.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts: { force?: boolean; deleteBranch?: string | null } = {},
  runner: GitRunner = defaultRunner,
): Promise<void> {
  const args = ['worktree', 'remove']
  if (opts.force) args.push('--force')
  args.push(worktreePath)
  log.info(`removing worktree: ${worktreePath}${opts.force ? ' (force)' : ''}`)
  try {
    await runner(args, repoPath)
  } catch (err) {
    // Worktree may already be gone (manually deleted). `git worktree
    // prune` cleans the metadata. Only swallow ENOENT-shaped errors.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/not a working tree|does not exist|No such file/i.test(msg)) throw err
    log.warn(`remove failed cleanly, falling back to prune: ${msg}`)
    await runner(['worktree', 'prune'], repoPath)
  }

  if (opts.deleteBranch && opts.deleteBranch.startsWith('kanban/')) {
    try {
      await runner(['branch', '-d', opts.deleteBranch], repoPath)
    } catch (err) {
      log.warn(`branch delete (${opts.deleteBranch}) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * `git worktree list --porcelain` parser. Each record is a blank-line
 * separated block of `key value` lines. Linked worktrees (the ones we
 * care about) carry `worktree`, `HEAD`, and either `branch refs/heads/X`
 * or `detached`. The main checkout is always the first record; we drop it,
 * and `mainPath` too, so neither the real checkout nor the project itself
 * (when a project is opened from a linked worktree) is ever offered as one.
 */
export function parseWorktreeList(porcelain: string, mainPath: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  // Normalize the main path the same way we normalize each `worktree` line so
  // the skip-main comparison works on Windows too (`resolve('/repo')` yields
  // `D:\repo` there, which would otherwise never match a raw '/repo' input).
  const mainResolved = resolve(mainPath)
  let cur: Partial<WorktreeInfo> & { _detached?: boolean; _prunable?: boolean; _locked?: boolean } = {}
  let seenMain = false
  const flush = () => {
    if (!cur.path) return
    const isMain = !seenMain
    seenMain = true
    if (!isMain && cur.head && cur.path !== mainResolved) {
      out.push({
        path: cur.path,
        head: cur.head,
        branch: cur.branch ?? null,
        prunable: cur._prunable ?? false,
        locked: cur._locked ?? false,
        inUse: false,
      })
    }
    cur = {}
  }
  for (const line of porcelain.split('\n')) {
    if (line === '') { flush(); continue }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const val = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') cur.path = resolve(val)
    else if (key === 'HEAD') cur.head = val
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '')
    else if (key === 'detached') cur._detached = true
    else if (key === 'prunable') cur._prunable = true
    else if (key === 'locked') cur._locked = true
  }
  flush()
  return out
}

export async function listWorktrees(
  repoPath: string,
  runner: GitRunner = defaultRunner,
): Promise<WorktreeInfo[]> {
  const { stdout } = await runner(['worktree', 'list', '--porcelain'], repoPath)
  return parseWorktreeList(stdout, repoPath)
}

/**
 * Find worktrees the user can probably nuke: prunable (per git itself),
 * or reachable on disk but the directory is missing, or referenced by
 * no kanban card. Caller passes the set of paths still in use by cards;
 * everything else under the managed root is considered stale, except what
 * `protection` covers (the whole project, or one worktree) and what git
 * has locked.
 */
export async function findStaleWorktrees(
  repoPath: string,
  inUsePaths: Set<string>,
  runner: GitRunner = defaultRunner,
  protection: WorktreeProtection = { projects: [], worktrees: [] },
): Promise<WorktreeInfo[]> {
  if (protection.projects.includes(repoPath)) return []
  const all = await listWorktrees(repoPath, runner)
  const root = worktreeRootFor(repoPath)
  const stale: WorktreeInfo[] = []
  for (const wt of all) {
    const underManagedRoot = wt.path.startsWith(root)
    if (!underManagedRoot) continue // user-created worktree, leave alone
    if (wt.locked || protectionSource(protection, repoPath, wt.path)) continue
    const exists = await pathExists(wt.path)
    const orphaned = !inUsePaths.has(wt.path)
    if (wt.prunable || !exists || orphaned) {
      stale.push({ ...wt, inUse: inUsePaths.has(wt.path) })
    }
  }
  return stale
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}
