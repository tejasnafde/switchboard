/**
 * Copy-on-write `node_modules` clone for new worktrees. Exercises the
 * per-platform command/argv, the pre-flight same-device and macOS-APFS
 * checks (macOS `cp -c` silently falls back to a real copy instead of
 * failing when clonefile isn't available, so these must run BEFORE
 * `cp`, not be inferred from its exit code), the staging-dir + atomic
 * rename contract (never write straight into a worktree's live
 * `node_modules`, never adopt a staged clone if the real thing showed
 * up first), the skip conditions (missing source, existing destination,
 * unsupported platform, opt-out setting), the ENOENT-vs-other-error
 * distinction in the existence check, and the "never fall back to a
 * full copy" contract: a failed clone leaves no trace but its own
 * staging dir and never retries with a plain recursive copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, access, readdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => string | null>(() => null),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))
vi.mock('../../src/main/db/database', () => ({
  getSetting: mocks.getSetting,
}))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => mocks.log,
}))

import {
  cloneDependencyDirs,
  cloneDependencyDirsInBackground,
  isDependencyCloneEnabled,
  checkSameDevice,
  checkIsApfs,
  DEPENDENCY_DIR_NAME,
  WORKTREE_CLONE_DEPENDENCIES_SETTING,
  type CloneRunner,
  type AccessFn,
} from '../../src/main/git/dependencyClone'

afterEach(() => {
  mocks.log.info.mockClear()
  mocks.log.warn.mockClear()
  mocks.log.error.mockClear()
  mocks.log.debug.mockClear()
})

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sb-dep-clone-test-'))
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Staging dirs land beside `node_modules` as `node_modules.sb-clone-<suffix>`. */
async function stagingDirsIn(worktreeRoot: string): Promise<string[]> {
  const entries = await readdir(worktreeRoot).catch(() => [])
  return entries.filter((name) => name.startsWith(`${DEPENDENCY_DIR_NAME}.sb-clone-`))
}

/** A runner that behaves like a real `cp`: creates the staged dir it was told to write. */
function fakeCloningRunner(): { runner: CloneRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const runner: CloneRunner = async (cmd, args) => {
    calls.push({ cmd, args })
    await mkdir(args[args.length - 1], { recursive: true })
    return { stdout: '', stderr: '' }
  }
  return { runner, calls }
}

const passingChecks = {
  isEnabled: () => true,
  sameDevice: async () => true,
  isApfs: async () => true,
  stagingSuffix: () => 'fixedsuffix',
}

// Whether this machine's temp filesystem actually meets the precondition
// the real code checks before touching `cp` - same device, and on macOS,
// APFS. Computed once via the SAME exported checks `cloneDependencyDirs`
// uses, so the "real defaults" test below only attempts a real clone
// when it is expected to succeed; on Linux/Windows CI it is skipped by
// design (Linux temp filesystems are commonly ext4, which does not
// support --reflink=always, and Windows has no clone strategy at all).
const realCloneReadyRoot = await mkdtemp(join(tmpdir(), 'sb-dep-clone-precheck-'))
const realCloneReady = await (async () => {
  try {
    if (osPlatform() !== 'darwin') return false
    if (!(await checkSameDevice(realCloneReadyRoot, tmpdir()))) return false
    return checkIsApfs(realCloneReadyRoot)
  } finally {
    await rm(realCloneReadyRoot, { recursive: true, force: true })
  }
})()

describe('cloneDependencyDirs', () => {
  it('runs `cp -c -R <src> <staging>` on darwin, then renames staging into place', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })
      const { runner, calls } = fakeCloningRunner()
      const staging = join(worktreeRoot, `${DEPENDENCY_DIR_NAME}.sb-clone-fixedsuffix`)
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'darwin' })

      expect(calls).toEqual([
        { cmd: 'cp', args: ['-c', '-R', join(sourceRoot, DEPENDENCY_DIR_NAME), staging] },
      ])
      expect(await exists(staging)).toBe(false)
      expect(await exists(dst)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs `cp -R --reflink=always <src> <staging>` on linux, then renames staging into place', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })
      const { runner, calls } = fakeCloningRunner()
      const staging = join(worktreeRoot, `${DEPENDENCY_DIR_NAME}.sb-clone-fixedsuffix`)
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'linux' })

      expect(calls).toEqual([
        { cmd: 'cp', args: ['-R', '--reflink=always', join(sourceRoot, DEPENDENCY_DIR_NAME), staging] },
      ])
      expect(await exists(staging)).toBe(false)
      expect(await exists(dst)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does nothing on an unsupported platform (e.g. win32) and never falls back to a full copy', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'win32' })

      expect(runner).not.toHaveBeenCalled()
      expect(await exists(join(worktreeRoot, DEPENDENCY_DIR_NAME))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips when the source has no node_modules, and never logs (ENOENT is the expected no-op case)', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(sourceRoot, { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))
      const isEnabled = vi.fn(() => true)

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { runner, platform: 'darwin', isEnabled })

      expect(runner).not.toHaveBeenCalled()
      // The common no-op case (no node_modules yet) must not touch the
      // opt-out setting at all.
      expect(isEnabled).not.toHaveBeenCalled()
      expect(mocks.log.warn).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('logs and skips when checking the source raises an unexpected error (not ENOENT)', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(sourceRoot, { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))
      // Deterministic EACCES for the source path, cross-platform (chmod
      // 000 does not block access on Windows, or when running as root).
      const eaccesOnSource: AccessFn = async (p) => {
        if (p === join(sourceRoot, DEPENDENCY_DIR_NAME)) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
          err.code = 'EACCES'
          throw err
        }
        return access(p)
      }

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        ...passingChecks,
        runner,
        platform: 'darwin',
        access: eaccesOnSource,
      })

      expect(runner).not.toHaveBeenCalled()
      expect(mocks.log.warn).toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips when the worktree already has a node_modules', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(join(worktreeRoot, DEPENDENCY_DIR_NAME), { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'darwin' })

      expect(runner).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips when the opt-out setting is disabled', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        ...passingChecks,
        runner,
        platform: 'darwin',
        isEnabled: () => false,
      })

      expect(runner).not.toHaveBeenCalled()
      expect(await exists(join(worktreeRoot, DEPENDENCY_DIR_NAME))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips, without calling cp, when source and worktree are on different devices/volumes', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))
      const isApfs = vi.fn(async () => true)

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        ...passingChecks,
        runner,
        isApfs,
        platform: 'darwin',
        sameDevice: async () => false,
      })

      expect(runner).not.toHaveBeenCalled()
      // Cross-device already answers the question; the more expensive
      // (subprocess-spawning) APFS check should not even run.
      expect(isApfs).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips, without calling cp, when the macOS destination filesystem is not confirmed APFS', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner = vi.fn<CloneRunner>(async () => ({ stdout: '', stderr: '' }))

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        ...passingChecks,
        runner,
        platform: 'darwin',
        isApfs: async () => false,
      })

      expect(runner).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not run the APFS check on linux (reflink already fails safely on its own)', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })
      const { runner } = fakeCloningRunner()
      const isApfs = vi.fn(async () => true)

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, isApfs, platform: 'linux' })

      expect(isApfs).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes the staging dir and does not retry with a full copy when the clone command fails', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)

      const runner: CloneRunner = vi.fn(async (_cmd, args) => {
        // Simulate a clone that got partway before failing - it should
        // have left a partial staging dir, not a partial node_modules.
        await mkdir(args[args.length - 1], { recursive: true })
        throw new Error('cp: reflink failed')
      })

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'linux' })

      expect(runner).toHaveBeenCalledTimes(1)
      expect(await exists(dst)).toBe(false)
      expect(await stagingDirsIn(worktreeRoot)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discards the staged clone without touching node_modules if it appears mid-clone', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)

      const runner: CloneRunner = async (_cmd, args) => {
        // The clone "succeeds" into staging, but meanwhile an agent's
        // `npm install` finished and created the real node_modules
        // first - simulate that race right here.
        await mkdir(args[args.length - 1], { recursive: true })
        await mkdir(dst, { recursive: true })
        await writeFile(join(dst, 'marker.txt'), 'installed-by-agent')
        return { stdout: '', stderr: '' }
      }

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'darwin' })

      // The agent's real node_modules must survive untouched.
      expect(await readFile(join(dst, 'marker.txt'), 'utf8')).toBe('installed-by-agent')
      // And the losing staged clone must not be left behind.
      expect(await stagingDirsIn(worktreeRoot)).toEqual([])
      expect(mocks.log.warn).toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never rejects even when the runner throws', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const runner: CloneRunner = async () => {
        throw new Error('boom')
      }

      await expect(
        cloneDependencyDirs(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'darwin' }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Runs the REAL same-device and real APFS detection - no overrides -
  // against actual temp directories on this machine, so the
  // `mount`-parsing logic is checked against a real mount table at
  // least once, not just through injected fakes. Gated by `realCloneReady`,
  // computed above with the exact same exported checks the code uses
  // against os.tmpdir(), so this shows as SKIPPED (not a silent no-op
  // pass) on Linux/Windows CI where the precondition legitimately does
  // not hold - a Linux CI runner's temp filesystem is commonly ext4,
  // which does not support --reflink=always, and Windows has no clone
  // strategy at all.
  it.skipIf(!realCloneReady)('clones for real using the default same-device / APFS checks on this machine', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await writeFile(join(sourceRoot, DEPENDENCY_DIR_NAME, 'pkg.txt'), 'hello')
      await mkdir(worktreeRoot, { recursive: true })
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        isEnabled: () => true,
        // No sameDevice/isApfs/runner override: exercises the real
        // implementations end to end.
      })

      expect(await readFile(join(dst, 'pkg.txt'), 'utf8')).toBe('hello')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('cloneDependencyDirsInBackground', () => {
  it('does not block the caller and does not throw synchronously', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      let resolveRunner!: () => void
      const gate = new Promise<void>((resolve) => {
        resolveRunner = resolve
      })
      let calls = 0
      const runner: CloneRunner = async (_cmd, args) => {
        calls += 1
        await gate
        // Actually perform the copy so we can observe completion on disk.
        await mkdir(args[args.length - 1], { recursive: true })
        return { stdout: '', stderr: '' }
      }

      expect(() =>
        cloneDependencyDirsInBackground(sourceRoot, worktreeRoot, { ...passingChecks, runner, platform: 'darwin' }),
      ).not.toThrow()

      // Fire-and-forget: the call above returns before the runner has
      // even started, since fs existence checks precede it.
      resolveRunner()

      // Poll instead of assuming a fixed number of ticks, since the
      // chain crosses real fs I/O (pathExists) as well as microtasks.
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)
      const deadline = Date.now() + 1000
      while (!(await exists(dst)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(await exists(dst)).toBe(true)
      expect(calls).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('isDependencyCloneEnabled', () => {
  it('defaults to enabled when the setting is unset', () => {
    mocks.getSetting.mockReturnValue(null)
    expect(isDependencyCloneEnabled()).toBe(true)
  })

  it('is disabled only when the setting is the literal string "false"', () => {
    mocks.getSetting.mockImplementation((key: string) =>
      key === WORKTREE_CLONE_DEPENDENCIES_SETTING ? 'false' : null,
    )
    expect(isDependencyCloneEnabled()).toBe(false)
  })

  it('stays enabled for any other value', () => {
    mocks.getSetting.mockReturnValue('yes-please')
    expect(isDependencyCloneEnabled()).toBe(true)
  })
})
