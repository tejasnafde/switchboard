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
 *     **`cp -c` does NOT fail when clonefile isn't available - it
 *     silently falls back to a real, full copy instead** (cp(1): "if
 *     the file cannot be cloned a normal copy is used"). Verified on
 *     this Mac: `cp -c -R` from one HFS+-formatted volume into itself
 *     exits 0 and produces byte-identical files with none of the
 *     source's clonefile sharing. A non-zero exit can never be relied
 *     on to catch this, so we check BEFORE calling `cp`: source and the
 *     destination's parent must be the same device (`fs.stat().dev`,
 *     which also rules out crossing volumes), and that device's
 *     filesystem must be APFS. There is no public, documented Node API
 *     for the filesystem type string, so this shells out to `mount` and
 *     reads the type `mount` itself prints in parentheses - verified on
 *     this Mac against the real root volume (apfs) and a scratch
 *     HFS+ disk image (hfs); `fs.statfs().type` returns undocumented,
 *     unstable magic numbers instead (26 here, but Apple documents no
 *     mapping from that number to a filesystem name).
 *   - Linux (btrfs / XFS with reflink): `cp -R --reflink=always` requests
 *     the same thing via a reflink. This FAILS outright (non-zero exit,
 *     nothing written) on ext4 or any filesystem without reflink
 *     support, which is intentional - we want a hard failure there, not
 *     a silent full copy. The same-device check still runs first here
 *     too: it is cheap, and it turns a cross-volume attempt into a clean
 *     skip instead of a `cp` invocation we already know will fail.
 *   - Everything else (Windows, or any failure on macOS/Linux): do
 *     nothing. A full `cp -R` fallback would silently turn a disk-space
 *     bug report into a worse one, so there is no fallback path here,
 *     ever.
 *
 * The clone itself lands in a staging directory next to the real
 * target (`node_modules.sb-clone-<random>`, same worktree, so the final
 * step is an atomic same-volume rename) rather than writing straight
 * into `<worktree>/node_modules`. The worktree is already usable the
 * moment `git worktree add` returns, so an agent can start `npm
 * install` there before this background clone finishes; writing
 * directly into `node_modules` would race that install, and a failed
 * clone's cleanup would then delete files the install already wrote.
 * Staging first means a failure only ever removes the staging
 * directory, never `node_modules` itself, and the swap-in is skipped
 * entirely (staging removed, nothing renamed) if `node_modules` exists
 * by the time the clone finishes.
 *
 * This function never throws and never blocks its caller on failure -
 * callers are expected to fire it in the background right after the
 * worktree exists (see `worktree.ts`, `git-adapter.ts`,
 * `legacy-session-worktree-lease.ts`) so a clone that fails, or simply
 * takes a while on a big `node_modules`, never delays or fails worktree
 * creation itself.
 */

import { execFile } from 'node:child_process'
import { access, rename, rm, stat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { platform as osPlatform } from 'node:os'
import { randomUUID } from 'node:crypto'
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

/** Test seam for the existence check, tests only. Defaults to `fs.access`. */
export type AccessFn = (p: string) => Promise<void>

const defaultAccess: AccessFn = (p) => access(p)

async function pathExists(p: string, accessFn: AccessFn): Promise<boolean> {
  try {
    await accessFn(p)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      log.debug(`dependency clone: ${p} does not exist`)
    } else {
      log.warn(`dependency clone: unexpected error checking ${p}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }
}

/**
 * Same device (and therefore same volume) - required for both clonefile
 * and reflink. Exported so callers, and tests exercising the real
 * environment, can reuse the exact check `cloneDependencyDirs` uses
 * rather than re-deriving the precondition another way.
 */
export async function checkSameDevice(a: string, b: string): Promise<boolean> {
  try {
    const [statA, statB] = await Promise.all([stat(a), stat(b)])
    return statA.dev === statB.dev
  } catch (err) {
    log.warn(`dependency clone: could not compare devices for ${a} / ${b}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// Matches a `mount` output line's mount point and the first (type) token
// inside its parenthesized option list, e.g.:
//   /dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
//   /dev/disk8s1 on /Volumes/sbtest (hfs, local, nodev, ...)
const MOUNT_LINE_RE = /^\S+\son\s(.+)\s\(([a-zA-Z0-9_.+-]+)/

/**
 * Is `p` on an APFS volume? Shells out to `mount` and matches the
 * longest mount-point prefix of `p`'s realpath, since Node has no
 * public API for the filesystem type string (`fs.statfs().type` is an
 * undocumented magic number - see the module doc comment for why that
 * was rejected). Any failure (spawn error, no matching mount line)
 * returns false, which skips the clone rather than risking a silent
 * `cp -c` fallback to a full copy. Exported for the same reason as
 * `checkSameDevice`.
 */
export async function checkIsApfs(p: string): Promise<boolean> {
  try {
    const real = await realpath(p)
    const { stdout } = await execFileP('mount', [])
    let bestPoint = ''
    let bestType = ''
    for (const line of stdout.split('\n')) {
      const m = line.match(MOUNT_LINE_RE)
      if (!m) continue
      const point = m[1] === '/' ? '/' : m[1].replace(/\/$/, '')
      const matches = real === point || real.startsWith(point === '/' ? '/' : `${point}/`)
      if (matches && point.length >= bestPoint.length) {
        bestPoint = point
        bestType = m[2]
      }
    }
    return bestType.toLowerCase() === 'apfs'
  } catch (err) {
    log.warn(`dependency clone: could not determine filesystem type for ${p}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function removeStaging(staging: string): Promise<void> {
  try {
    await rm(staging, { recursive: true, force: true })
  } catch (rmErr) {
    log.warn(`dependency clone: failed to remove staging dir ${staging}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`)
  }
}

export interface CloneDependencyDirsOptions {
  runner?: CloneRunner
  /** Override for `os.platform()`, tests only. */
  platform?: NodeJS.Platform
  /** Override for the opt-out setting check, tests only. */
  isEnabled?: () => boolean
  /** Override for the same-device check, tests only. */
  sameDevice?: (a: string, b: string) => Promise<boolean>
  /** Override for the macOS APFS check, tests only. */
  isApfs?: (p: string) => Promise<boolean>
  /** Override for the staging-dir suffix, tests only. */
  stagingSuffix?: () => string
  /** Override for the existence check's `fs.access`, tests only. */
  access?: AccessFn
}

/**
 * Clone `<sourceRoot>/node_modules` into `<worktreeRoot>/node_modules`
 * with a copy-on-write filesystem clone, if the source has one and the
 * worktree doesn't already.
 *
 * Never throws. Every failure path (unsupported platform, missing
 * source, existing destination, cross-device, non-APFS target, clone
 * command failure) logs once at info/warn and returns.
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
  const accessFn = options.access ?? defaultAccess

  if (!(await pathExists(src, accessFn))) return
  if (await pathExists(dst, accessFn)) return

  const isEnabled = options.isEnabled ?? isDependencyCloneEnabled
  if (!isEnabled()) return

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    log.info(`dependency clone skipped: unsupported platform ${platform}`)
    return
  }

  const sameDevice = options.sameDevice ?? checkSameDevice
  if (!(await sameDevice(src, worktreeRoot))) {
    log.info(`dependency clone skipped: source and worktree are on different devices/volumes`)
    return
  }

  if (platform === 'darwin') {
    const isApfs = options.isApfs ?? checkIsApfs
    if (!(await isApfs(worktreeRoot))) {
      log.info(`dependency clone skipped: destination filesystem is not confirmed APFS (cp -c silently falls back to a full copy otherwise)`)
      return
    }
  }

  const suffix = (options.stagingSuffix ?? (() => randomUUID().slice(0, 8)))()
  const staging = join(worktreeRoot, `${DEPENDENCY_DIR_NAME}.sb-clone-${suffix}`)
  const args = cloneArgsFor(platform, src, staging)
  if (!args) {
    log.info(`dependency clone skipped: no clone strategy for platform ${platform}`)
    return
  }

  const runner = options.runner ?? defaultRunner
  const startedAt = Date.now()
  log.info(`dependency clone starting: ${src} -> ${staging} (${platform}, will move to ${dst} on success)`)
  try {
    await runner('cp', args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`dependency clone failed after ${Date.now() - startedAt}ms, removing staging dir: ${msg}`)
    await removeStaging(staging)
    return
  }

  // The install this clone raced against may have finished, or started
  // and finished, while `cp` was running. Adopt the staged clone only if
  // node_modules is still absent; otherwise the agent's real work wins
  // and the staged clone is discarded.
  if (await pathExists(dst, accessFn)) {
    log.warn(`dependency clone: node_modules appeared during the clone, discarding staged clone: ${staging}`)
    await removeStaging(staging)
    return
  }
  try {
    await rename(staging, dst)
    log.info(`dependency clone completed in ${Date.now() - startedAt}ms: ${dst}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`dependency clone: failed to move staged clone into place, removing it: ${msg}`)
    await removeStaging(staging)
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
