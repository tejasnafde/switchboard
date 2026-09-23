/**
 * Copy-on-write `node_modules` clone for new worktrees. Exercises the
 * per-platform command/argv, the skip conditions (missing source,
 * existing destination, unsupported platform, opt-out setting), and
 * the "never fall back to a full copy" contract: a failed clone leaves
 * no partial destination and never retries with a plain recursive copy.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => string | null>(() => null),
}))
vi.mock('../../src/main/db/database', () => ({
  getSetting: mocks.getSetting,
}))

import {
  cloneDependencyDirs,
  cloneDependencyDirsInBackground,
  isDependencyCloneEnabled,
  DEPENDENCY_DIR_NAME,
  WORKTREE_CLONE_DEPENDENCIES_SETTING,
  type CloneRunner,
} from '../../src/main/git/dependencyClone'

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

describe('cloneDependencyDirs', () => {
  it('runs `cp -c -R <src> <dst>` on darwin', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const calls: Array<{ cmd: string; args: string[] }> = []
      const runner: CloneRunner = async (cmd, args) => {
        calls.push({ cmd, args })
        return { stdout: '', stderr: '' }
      }

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        runner,
        platform: 'darwin',
        isEnabled: () => true,
      })

      expect(calls).toEqual([
        {
          cmd: 'cp',
          args: [
            '-c',
            '-R',
            join(sourceRoot, DEPENDENCY_DIR_NAME),
            join(worktreeRoot, DEPENDENCY_DIR_NAME),
          ],
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs `cp -R --reflink=always <src> <dst>` on linux', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })

      const calls: Array<{ cmd: string; args: string[] }> = []
      const runner: CloneRunner = async (cmd, args) => {
        calls.push({ cmd, args })
        return { stdout: '', stderr: '' }
      }

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        runner,
        platform: 'linux',
        isEnabled: () => true,
      })

      expect(calls).toEqual([
        {
          cmd: 'cp',
          args: [
            '-R',
            '--reflink=always',
            join(sourceRoot, DEPENDENCY_DIR_NAME),
            join(worktreeRoot, DEPENDENCY_DIR_NAME),
          ],
        },
      ])
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

      await cloneDependencyDirs(sourceRoot, worktreeRoot, {
        runner,
        platform: 'win32',
        isEnabled: () => true,
      })

      expect(runner).not.toHaveBeenCalled()
      expect(await exists(join(worktreeRoot, DEPENDENCY_DIR_NAME))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips when the source has no node_modules', async () => {
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

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { runner, platform: 'darwin', isEnabled: () => true })

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

  it('removes a partial destination and does not retry with a full copy when the clone command fails', async () => {
    const root = await makeTempRoot()
    try {
      const sourceRoot = join(root, 'source')
      const worktreeRoot = join(root, 'worktree')
      await mkdir(join(sourceRoot, DEPENDENCY_DIR_NAME), { recursive: true })
      await mkdir(worktreeRoot, { recursive: true })
      const dst = join(worktreeRoot, DEPENDENCY_DIR_NAME)

      const runner: CloneRunner = vi.fn(async () => {
        // Simulate a clone that got partway before the platform refused
        // (e.g. reflink not supported on this filesystem after all) -
        // it should have left a partial destination on disk.
        await mkdir(dst, { recursive: true })
        throw new Error('cp: reflink failed')
      })

      await cloneDependencyDirs(sourceRoot, worktreeRoot, { runner, platform: 'linux', isEnabled: () => true })

      expect(runner).toHaveBeenCalledTimes(1)
      expect(await exists(dst)).toBe(false)
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
        cloneDependencyDirs(sourceRoot, worktreeRoot, { runner, platform: 'darwin', isEnabled: () => true }),
      ).resolves.toBeUndefined()
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
      const runner: CloneRunner = async (cmd, args) => {
        calls += 1
        await gate
        // Actually perform the copy so we can observe completion on disk.
        await mkdir(args[args.length - 1], { recursive: true })
        return { stdout: '', stderr: '' }
      }

      expect(() =>
        cloneDependencyDirsInBackground(sourceRoot, worktreeRoot, { runner, platform: 'darwin', isEnabled: () => true }),
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
