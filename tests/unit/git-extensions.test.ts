/**
 * Tests for the git CLI helpers added to `worktree.ts` for the Branches
 * screen merge orchestrator. Each helper takes a `GitRunner` so we
 * verify exact argv + cwd without shelling out.
 *
 * Mirrors the existing `worktree.test.ts` style: mock the runner with
 * `vi.fn()`, assert calls + outputs, exercise the error paths
 * explicitly (rebase conflict, merge-tree non-zero exit).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  currentBranchOf,
  statusPorcelain,
  mergeTreeWriteTree,
  gitVersion,
  rebaseOnto,
  rebaseAbort,
  isInsideRebase,
} from '../../src/main/worktree'

describe('currentBranchOf', () => {
  it('returns the trimmed branch name', async () => {
    const runner = vi.fn(async () => ({ stdout: 'kanban/auth-12345678\n', stderr: '' }))
    expect(await currentBranchOf('/repo/wt', runner)).toBe('kanban/auth-12345678')
    expect(runner).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], '/repo/wt')
  })

  it('returns null for detached HEAD', async () => {
    const runner = vi.fn(async () => ({ stdout: 'HEAD\n', stderr: '' }))
    expect(await currentBranchOf('/repo/wt', runner)).toBe(null)
  })
})

describe('statusPorcelain', () => {
  it('returns empty string for a clean tree', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    expect(await statusPorcelain('/repo/wt', runner)).toBe('')
    expect(runner).toHaveBeenCalledWith(['status', '--porcelain'], '/repo/wt')
  })

  it('returns the raw porcelain block for a dirty tree', async () => {
    const stdout = ' M foo.ts\n?? bar.ts\n'
    const runner = vi.fn(async () => ({ stdout, stderr: '' }))
    expect(await statusPorcelain('/repo/wt', runner)).toBe(stdout)
  })
})

describe('mergeTreeWriteTree', () => {
  it('returns the tree SHA and an empty conflict list on a clean merge', async () => {
    const runner = vi.fn(async () => ({ stdout: 'aaaaaaaaaa\n', stderr: '' }))
    const result = await mergeTreeWriteTree('/repo', 'main', 'feature', runner)
    expect(result).toEqual({
      treeSha: 'aaaaaaaaaa',
      conflictFiles: [],
      conflicted: false,
    })
    expect(runner).toHaveBeenCalledWith(
      ['merge-tree', '--write-tree', '--name-only', 'main', 'feature'],
      '/repo',
    )
  })

  it('parses conflict files when the runner rejects with non-zero exit', async () => {
    const err = Object.assign(new Error('exit 1'), {
      stdout: 'bbbbbbbbbb\n\nfoo.ts\nbar.ts\n',
      stderr: '',
      code: 1,
    })
    const runner = vi.fn(async () => { throw err })
    const result = await mergeTreeWriteTree('/repo', 'main', 'feature', runner)
    expect(result.conflicted).toBe(true)
    expect(result.treeSha).toBe('bbbbbbbbbb')
    expect(result.conflictFiles).toEqual(['foo.ts', 'bar.ts'])
  })

  it('rethrows non-conflict errors (e.g. unknown ref)', async () => {
    const runner = vi.fn(async () => { throw new Error('fatal: unknown ref ghost') })
    await expect(mergeTreeWriteTree('/repo', 'main', 'ghost', runner)).rejects.toThrow(/ghost/)
  })
})

describe('gitVersion', () => {
  it('parses a semver tuple from `git --version`', async () => {
    const runner = vi.fn(async () => ({ stdout: 'git version 2.45.1\n', stderr: '' }))
    const v = await gitVersion(runner)
    expect({ major: v.major, minor: v.minor, patch: v.patch }).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
    })
    expect(v.raw).toBe('git version 2.45.1')
  })

  it('handles trailing build metadata in the version string', async () => {
    const runner = vi.fn(async () => ({
      stdout: 'git version 2.39.3 (Apple Git-145)\n',
      stderr: '',
    }))
    const v = await gitVersion(runner)
    expect([v.major, v.minor, v.patch]).toEqual([2, 39, 3])
  })

  it('throws on unparseable output', async () => {
    const runner = vi.fn(async () => ({ stdout: 'not git\n', stderr: '' }))
    await expect(gitVersion(runner)).rejects.toThrow(/version/i)
  })
})

describe('rebaseOnto', () => {
  it('returns clean status when rebase succeeds', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const result = await rebaseOnto('/repo/wt', 'main', runner)
    expect(result.status).toBe('clean')
    expect(result.conflictFiles).toEqual([])
    expect(runner).toHaveBeenCalledWith(['rebase', 'main'], '/repo/wt')
  })

  it('lists unmerged files when rebase pauses on conflict', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'rebase') {
        throw Object.assign(new Error('CONFLICT'), { code: 1 })
      }
      if (args[0] === 'diff') {
        return { stdout: 'foo.ts\nbar.ts\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const result = await rebaseOnto('/repo/wt', 'main', runner)
    expect(result.status).toBe('conflict')
    expect(result.conflictFiles).toEqual(['foo.ts', 'bar.ts'])
    expect(runner).toHaveBeenCalledWith(
      ['diff', '--name-only', '--diff-filter=U'],
      '/repo/wt',
    )
  })
})

describe('rebaseAbort', () => {
  it('runs `git rebase --abort` in the worktree', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await rebaseAbort('/repo/wt', runner)
    expect(runner).toHaveBeenCalledWith(['rebase', '--abort'], '/repo/wt')
  })

  it('swallows "no rebase in progress" errors', async () => {
    const runner = vi.fn(async () => {
      throw new Error('fatal: No rebase in progress')
    })
    await expect(rebaseAbort('/repo/wt', runner)).resolves.toBeUndefined()
  })
})

describe('isInsideRebase', () => {
  it('returns true when .git/rebase-merge is present', async () => {
    const runner = vi.fn(async () => ({
      stdout: '.git\n',
      stderr: '',
    }))
    const fsAccess = vi.fn(async () => undefined) // exists
    expect(await isInsideRebase('/repo/wt', runner, fsAccess)).toBe(true)
  })

  it('returns false when neither rebase dir is present', async () => {
    const runner = vi.fn(async () => ({ stdout: '.git\n', stderr: '' }))
    const fsAccess = vi.fn(async () => { throw new Error('ENOENT') })
    expect(await isInsideRebase('/repo/wt', runner, fsAccess)).toBe(false)
  })
})
