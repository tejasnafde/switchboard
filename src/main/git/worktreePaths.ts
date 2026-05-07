/**
 * Deterministic path scheme for "new session in worktree mode".
 *
 * Layout:  `<userDataDir>/worktrees/<repoSlug>-<projectHash>/<branchSlug>`
 *
 * Why under userData and not under the project tree?
 *   - Avoids the macOS TCC trap (CLAUDE.md gotcha): projects under
 *     ~/Desktop/~/Documents/~/Downloads inherit a strict permission
 *     model; child dirs we create inside them require the same grant.
 *     `<userDataDir>/...` is always writable by us.
 *   - Centralizes worktrees so the user has one place to look (and one
 *     place to clean up).
 *
 * Why include a project-path hash in the repo slug?
 *   - Two unrelated projects can share a basename (`/Users/me/work/api`
 *     vs `/Users/me/personal/api`). Without the hash they'd collide on
 *     disk and one would silently shadow the other.
 *
 * Cross-platform: every path goes through node:path. We never embed
 * literal `/` or `\` into composed paths.
 */
import { createHash } from 'node:crypto'
import { basename, join, sep } from 'node:path'

const MAX_BRANCH_SLUG_LEN = 60

/**
 * Generic slugifier shared by `slugForBranch` and `slugForRepo`. Lowercases,
 * replaces every non-alnum run with a single `-`, trims leading/trailing
 * dashes, and caps the output at `maxLen`.
 */
function slugify(input: string, maxLen: number): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
}

export function slugForBranch(branch: string): string {
  return slugify(branch, MAX_BRANCH_SLUG_LEN) || 'branch'
}

/**
 * Strip any trailing separator before taking the basename — both POSIX
 * and Windows conventions. Then slugify so the on-disk dir name is
 * file-system safe regardless of what the user named their repo.
 */
export function slugForRepo(projectPath: string): string {
  // Replace backslashes with forward slashes so basename works for win32
  // paths even when this code runs on a posix host (and vice versa).
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = basename(normalized)
  return slugify(base, 40) || 'repo'
}

/** 8-char hex hash of the absolute project path — collision avoidance. */
function projectPathHash(projectPath: string): string {
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 8)
}

export interface ResolveOpts {
  userDataDir: string
  projectPath: string
  branch: string
}

export function resolveSessionWorktreePath(opts: ResolveOpts): string {
  const repoDir = `${slugForRepo(opts.projectPath)}-${projectPathHash(opts.projectPath)}`
  const branchDir = slugForBranch(opts.branch)
  return join(opts.userDataDir, 'worktrees', repoDir, branchDir)
}

/**
 * Re-exported for callers that need the raw separator (e.g. assertions
 * involving relpath construction). Keeps test fixtures honest about
 * cross-platform behaviour.
 */
export { sep }
