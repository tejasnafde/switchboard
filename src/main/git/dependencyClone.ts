/**
 * Copy-on-write clone of a project's `node_modules` into a freshly
 * created worktree.
 *
 * Why: every new worktree starts with no `node_modules`, so the agent
 * runs `npm install` and the machine ends up with one full copy per
 * worktree - hundreds of MB each, and it adds up fast on a laptop with
 * several worktrees open. A copy-on-write clone gives the worktree its
 * own `node_modules` (so it can diverge - a different install, a patch)
 * at close to zero extra disk cost up front, because the filesystem
 * shares the underlying blocks until either side writes to one.
 *
 * Platform support is narrow ON PURPOSE:
 *   - macOS (APFS): `cp -c -R` requests a clonefile() per entry.
 *   - Linux (btrfs / XFS with reflink): `cp -R --reflink=always` requests
 *     the same thing via a reflink. This FAILS outright on ext4 or any
 *     filesystem without reflink support, which is intentional - we
 *     want a hard failure there, not a silent full copy.
 *   - Everything else (Windows, or any failure on macOS/Linux): do
 *     nothing. A full `cp -R` fallback would silently turn a disk-space
 *     bug report into a worse one, so there is no fallback path here,
 *     ever.
 *
 * This function never throws and never blocks its caller on failure -
 * callers are expected to fire it in the background right after the
 * worktree exists (see `worktree.ts`, `git-adapter.ts`,
 * `legacy-session-worktree-lease.ts`) so a clone that fails, or simply
 * takes a while on a big `node_modules`, never delays or fails worktree
 * creation itself.
 */

import { execFile } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { platform as osPlatform } from 'node:os'
import { promisify } from 'node:util'
import { getSetting } from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('git:dependency-clone')
const execFileP = promisify(execFile)

/** Name of the dependency directory we clone. Root-level only for now. */
export const DEPENDENCY_DIR_NAME = 'node_modules'

/** Settings key; unset or anything but the literal string 'false' means on. */
export const WORKTREE_CLONE_DEPENDENCIES_SETTING = 'worktree.cloneDependencies'

export function isDependencyCloneEnabled(): boolean {
  return getSetting(WORKTREE_CLONE_DEPENDENCIES_SETTING) !== 'false'
}

/**
 * Test seam. Default runs the given command via `execFile` with an
 * argument array (never a shell string, so a path with spaces or shell
 * metacharacters cannot be misinterpreted).
 */
export type CloneRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

const defaultRunner: CloneRunner = (cmd, args) => execFileP(cmd, args)

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux'])

function cloneArgsFor(platform: NodeJS.Platform, src: string, dst: string): string[] | null {
  if (platform === 'darwin') return ['-c', '-R', src, dst]
  if (platform === 'linux') return ['-R', '--reflink=always', src, dst]
  return null
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export interface CloneDependencyDirsOptions {
  runner?: CloneRunner
  /** Override for `os.platform()`, tests only. */
  platform?: NodeJS.Platform
  /** Override for the opt-out setting check, tests only. */
  isEnabled?: () => boolean
}

/**
 * Clone `<sourceRoot>/node_modules` into `<worktreeRoot>/node_modules`
 * with a copy-on-write filesystem clone, if the source has one and the
 * worktree doesn't already.
 *
 * Never throws. Every failure path (unsupported platform, missing
 * source, existing destination, clone command failure) logs once at
 * info/warn and returns.
 *
 * The opt-out setting is read only once there is actually something to
 * clone (source present, destination absent) - the common case in a
 * project with no `node_modules` yet, or a worktree that already has
 * one, never touches the settings DB at all.
 */
export async function cloneDependencyDirs(
  sourceRoot: string,
  worktreeRoot: string,
  options: CloneDependencyDirsOptions = {},
): Promise<void> {
  const src = join(sourceRoot, DEPENDENCY_DIR_NAME)
  const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)
  const platform = options.platform ?? osPlatform()

  if (!(await pathExists(src))) return
  if (await pathExists(dst)) return

  const isEnabled = options.isEnabled ?? isDependencyCloneEnabled
  if (!isEnabled()) return

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    log.info(`dependency clone skipped: unsupported platform ${platform}`)
    return
  }
  const args = cloneArgsFor(platform, src, dst)
  if (!args) {
    log.info(`dependency clone skipped: no clone strategy for platform ${platform}`)
    return
  }

  const runner = options.runner ?? defaultRunner
  const startedAt = Date.now()
  log.info(`dependency clone starting: ${src} -> ${dst} (${platform})`)
  try {
    await runner('cp', args)
    log.info(`dependency clone completed in ${Date.now() - startedAt}ms: ${dst}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`dependency clone failed after ${Date.now() - startedAt}ms, removing partial destination: ${msg}`)
    try {
      await rm(dst, { recursive: true, force: true })
    } catch (rmErr) {
      log.warn(`dependency clone: failed to remove partial destination ${dst}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`)
    }
  }
}

/**
 * Fire-and-forget wrapper for creation-flow call sites: runs the clone
 * in the background without awaiting or throwing into the caller. Call
 * this right after a worktree is confirmed to exist on disk.
 */
export function cloneDependencyDirsInBackground(
  sourceRoot: string,
  worktreeRoot: string,
  options: CloneDependencyDirsOptions = {},
): void {
  cloneDependencyDirs(sourceRoot, worktreeRoot, options).catch((err) => {
    // cloneDependencyDirs already catches everything internally, so this
    // is a last-resort net for a truly unexpected throw (e.g. a bad
    // `options.runner`), logged rather than left as an unhandled rejection.
    log.warn(`dependency clone: unexpected error: ${err instanceof Error ? err.message : String(err)}`)
  })
}
