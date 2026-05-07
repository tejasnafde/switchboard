/**
 * Git worktree primitives for the kanban card → isolated workspace flow.
 *
 * Why worktrees and not branches-in-place? The whole point of agentic
 * work is parallel iteration. If two cards both edit the main checkout,
 * one's `git checkout` kills the other's running tests / running
 * agent. Worktrees give every card its own working tree on its own
 * branch while sharing the underlying object DB — cheap, fast, and the
 * cleanup is `git worktree remove`.
 *
 * All functions shell out to the `git` CLI. We deliberately avoid
 * libgit2 / nodegit: git's worktree semantics are subtle (locked
 * worktrees, prunable refs, dirty workdirs), and the CLI's behaviour
 * is the canonical reference. Spawning a process per call is fine —
 * worktree ops happen at human pace, not in a hot loop.
 *
 * Pure-ish module: every fn takes paths + accepts an optional
 * `runner` for tests to inject a fake exec. Default runner uses
 * child_process.execFile with a 10s timeout.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, access, rm } from 'node:fs/promises'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { createMainLogger } from './logger'
import { resolveSessionWorktreePath } from './git/worktreePaths'
import type { WorktreeInfo } from '@shared/kanban'

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
 * Slugify a card title into a path-safe directory and branch suffix.
 * Lowercase, alnum + dash, trimmed to 40 chars. The card id is appended
 * by callers to guarantee uniqueness across same-titled cards.
 */
export function slugForCard(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
  return base || 'card'
}

/**
 * Create a new worktree at `<repo>/.switchboard/worktrees/<slug>-<shortId>`
 * checked out to a fresh branch `kanban/<slug>-<shortId>` based on
 * the repo's current HEAD.
 *
 * Throws if the path already exists or `git` rejects (e.g. the repo
 * isn't a git checkout, or the branch already exists).
 */
export async function createWorktree(
  repoPath: string,
  cardId: string,
  title: string,
  runner: GitRunner = defaultRunner,
): Promise<{ path: string; branch: string }> {
  if (!isAbsolute(repoPath)) throw new Error(`repoPath must be absolute: ${repoPath}`)
  const shortId = cardId.slice(0, 8)
  const slug = slugForCard(title)
  const dirName = `${slug}-${shortId}`
  const branch = `kanban/${dirName}`
  const worktreePath = join(worktreeRootFor(repoPath), dirName)

  await mkdir(worktreeRootFor(repoPath), { recursive: true })
  log.info(`creating worktree: ${worktreePath} (branch ${branch})`)
  await runner(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], repoPath)
  return { path: worktreePath, branch }
}

/**
 * Variant of `createWorktree` for the **fork-to-worktree** flow.
 *
 * Differences vs. the kanban path:
 *   - Caller provides the slug (derived from a message summary by
 *     `makeBranchSlug`) — no card id to mix in.
 *   - Caller picks the base ref so we can branch off whatever the
 *     parent conversation's `projectPath` was checked out to (which
 *     may itself be a feature branch, not always `main`/`HEAD`).
 *   - Branch / directory collisions resolve by suffix (`-2`, `-3`, …)
 *     instead of bailing — two forks of the same message are a
 *     legitimate user flow (try-this-then-try-that). Caps at
 *     COLLISION_MAX so a permanently-broken state doesn't spin.
 *
 * `slug` arrives in already-prefixed form (e.g. `fork/fix-redis`) — we
 * use it verbatim for the branch name and the basename of the worktree
 * directory after stripping the leading namespace.
 */
const COLLISION_MAX = 20

export async function createForkWorktree(
  opts: { repoRoot: string; baseRef: string; slug: string },
  runner: GitRunner = defaultRunner,
): Promise<{ path: string; branch: string }> {
  const { repoRoot, baseRef, slug } = opts
  if (!isAbsolute(repoRoot)) throw new Error(`repoRoot must be absolute: ${repoRoot}`)
  if (!slug) throw new Error('slug must be non-empty')

  // Branch name is the slug verbatim (callers pass `fork/<name>`); the
  // worktree dir uses the part after the last `/` so we don't end up with
  // a literal `fork/` subdirectory tree on disk (git is fine with it but
  // file managers and shells get confused).
  const dirBase = slug.includes('/') ? slug.slice(slug.lastIndexOf('/') + 1) : slug
  await mkdir(worktreeRootFor(repoRoot), { recursive: true })

  let lastErr: unknown = null
  for (let i = 1; i <= COLLISION_MAX; i++) {
    const branch = i === 1 ? slug : `${slug}-${i}`
    const dir = i === 1 ? dirBase : `${dirBase}-${i}`
    const worktreePath = join(worktreeRootFor(repoRoot), dir)
    log.info(`createForkWorktree: attempt ${i} → ${worktreePath} (branch ${branch}, base ${baseRef})`)
    try {
      await runner(['worktree', 'add', '-b', branch, worktreePath, baseRef], repoRoot)
      return { path: worktreePath, branch }
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      // Collision-shaped errors: branch exists, path exists, or path
      // already registered as a worktree. Anything else (e.g. shallow
      // repo, missing baseRef, no commits) is fatal — don't keep
      // retrying on a config problem the user has to fix.
      if (!/already exists|already used by|already checked out/i.test(msg)) {
        throw err
      }
    }
  }
  throw new Error(
    `createForkWorktree: exhausted ${COLLISION_MAX} suffix attempts for slug "${slug}". ` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

/**
 * Remove a worktree.  Defaults to a safe remove (refuses if dirty);
 * pass `force=true` from cleanup flows where the user has explicitly
 * acknowledged data loss.
 *
 * Also deletes the branch the worktree was on, iff it matches our
 * `kanban/` prefix — leaves user-created branches alone.
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
      await runner(['branch', '-D', opts.deleteBranch], repoPath)
    } catch (err) {
      log.warn(`branch delete (${opts.deleteBranch}) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * `git worktree list --porcelain` parser. Each record is a blank-line
 * separated block of `key value` lines. Linked worktrees (the ones we
 * care about) carry `worktree`, `HEAD`, and either `branch refs/heads/X`
 * or `detached`. The main checkout is included; we filter it out so the
 * UI shows only managed worktrees.
 */
export function parseWorktreeList(porcelain: string, mainPath: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  // Normalize the main path the same way we normalize each `worktree` line so
  // the skip-main comparison works on Windows too (`resolve('/repo')` yields
  // `D:\repo` there, which would otherwise never match a raw '/repo' input).
  const mainResolved = resolve(mainPath)
  let cur: Partial<WorktreeInfo> & { _detached?: boolean; _prunable?: boolean } = {}
  const flush = () => {
    if (cur.path && cur.head && cur.path !== mainResolved) {
      out.push({
        path: cur.path,
        head: cur.head,
        branch: cur.branch ?? null,
        prunable: cur._prunable ?? false,
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
 * everything else under the managed root is considered stale.
 */
export async function findStaleWorktrees(
  repoPath: string,
  inUsePaths: Set<string>,
  runner: GitRunner = defaultRunner,
): Promise<WorktreeInfo[]> {
  const all = await listWorktrees(repoPath, runner)
  const root = worktreeRootFor(repoPath)
  const stale: WorktreeInfo[] = []
  for (const wt of all) {
    const underManagedRoot = wt.path.startsWith(root)
    if (!underManagedRoot) continue // user-created worktree, leave alone
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

/**
 * Delete the on-disk directory for a worktree that git lost track of.
 * Used by the cleanup flow as a last-resort hammer when `git worktree
 * remove` and `prune` both refuse.
 */
export async function rmWorktreeDir(worktreePath: string): Promise<void> {
  await rm(worktreePath, { recursive: true, force: true })
}

/**
 * Create a worktree for a new chat session at a deterministic path under
 * `<userDataDir>/worktrees/...`. Stays outside the project tree to dodge
 * the macOS TCC trap (CLAUDE.md gotcha).
 *
 * Branch naming: every session worktree gets an `sb/` prefix so the
 * user can `git branch -D sb/*` to mass-clean. Slugs already prefixed
 * are passed through unchanged.
 *
 * Distinct from `createWorktree` (kanban) and `createForkWorktree`
 * (fork-from-message) because:
 *   - Path lives outside the project tree, not under `.switchboard/`
 *   - No collision-suffix retry — the deterministic path is the
 *     contract; if it's already taken the caller has a stale state to
 *     clean up explicitly.
 */
export interface CreateSessionWorktreeOpts {
  projectPath: string
  /** Human-meaningful branch slug — `sb/` prefix is added if missing. */
  branchSlug: string
  /** What to fork off. Defaults to `HEAD` (current branch tip). */
  baseRef?: string
  /** Where to root the worktree dir. Pass `app.getPath('userData')`. */
  userDataDir: string
}

export async function createSessionWorktree(
  opts: CreateSessionWorktreeOpts,
  runner: GitRunner = defaultRunner,
): Promise<{ path: string; branch: string }> {
  if (!isAbsolute(opts.projectPath)) {
    throw new Error(`projectPath must be absolute: ${opts.projectPath}`)
  }
  const branch = opts.branchSlug.startsWith('sb/') ? opts.branchSlug : `sb/${opts.branchSlug}`
  const baseRef = opts.baseRef ?? 'HEAD'
  const path = resolveSessionWorktreePath({
    userDataDir: opts.userDataDir,
    projectPath: opts.projectPath,
    branch,
  })
  // Ensure the parent dir exists — `git worktree add` requires the
  // *target* dir to be absent but the parent to be present.
  await mkdir(dirname(path), { recursive: true })
  log.info(`createSessionWorktree: ${path} (branch ${branch}, base ${baseRef})`)
  await runner(['worktree', 'add', '-b', branch, path, baseRef], opts.projectPath)
  return { path, branch }
}
