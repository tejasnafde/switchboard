/**
 * Worktree primitive tests. We exercise the parsing + slug logic
 * directly, and use a stub `GitRunner` to verify createWorktree /
 * removeWorktree / findStaleWorktrees issue the right git argv without
 * actually shelling out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  slugForCard,
  parseWorktreeList,
  worktreeRootFor,
  createWorktree,
  removeWorktree,
  findStaleWorktrees,
  WORKTREE_DIR_REL,
} from '../../src/main/worktree'

describe('slugForCard', () => {
  it('lowercases + dashes + trims', () => {
    expect(slugForCard('Refactor Provider Bus!!')).toBe('refactor-provider-bus')
  })
  it('collapses runs of separators', () => {
    expect(slugForCard('a  /  b __ c')).toBe('a-b-c')
  })
  it('caps at 40 chars', () => {
    expect(slugForCard('x'.repeat(80)).length).toBeLessThanOrEqual(40)
  })
  it('falls back to "card" for empty / all-junk titles', () => {
    expect(slugForCard('!!!')).toBe('card')
    expect(slugForCard('')).toBe('card')
  })
})

describe('parseWorktreeList', () => {
  const main = '/repo'
  it('returns linked worktrees, skips main, parses branch + prunable', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/.switchboard/worktrees/foo-12345678',
      'HEAD bbbbbbb',
      'branch refs/heads/kanban/foo-12345678',
      '',
      'worktree /repo/.switchboard/worktrees/orphan-xx',
      'HEAD ccccccc',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')
    const out = parseWorktreeList(porcelain, main)
    // Paths come back through `resolve()`, so on Windows they get drive
    // prefixes + backslashes. Compute expected via resolve() so the test
    // works cross-platform.
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      path: resolve('/repo/.switchboard/worktrees/foo-12345678'),
      branch: 'kanban/foo-12345678',
      prunable: false,
    })
    expect(out[1]).toMatchObject({
      path: resolve('/repo/.switchboard/worktrees/orphan-xx'),
      branch: null,
      prunable: true,
    })
  })

  it('handles empty input', () => {
    expect(parseWorktreeList('', main)).toEqual([])
  })
})

describe('createWorktree', () => {
  let repoPath: string
  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'sb-wt-'))
  })
  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('issues `git worktree add -b <branch> <path> HEAD` and returns the resolved path/branch', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const { path, branch } = await createWorktree(repoPath, 'card_abcdef0123', 'Refactor Bus', runner)
    expect(branch).toBe('kanban/refactor-bus-card_abc')
    expect(path).toBe(join(worktreeRootFor(repoPath), 'refactor-bus-card_abc'))
    expect(runner).toHaveBeenCalledOnce()
    const [args, cwd] = runner.mock.calls[0]
    expect(args).toEqual(['worktree', 'add', '-b', branch, path, 'HEAD'])
    expect(cwd).toBe(repoPath)
  })

  it('rejects relative repo paths', async () => {
    await expect(createWorktree('relative/path', 'card_x', 'X')).rejects.toThrow(/absolute/)
  })
})

describe('removeWorktree', () => {
  it('passes --force when requested and deletes only kanban/* branches', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await removeWorktree('/repo', '/repo/.switchboard/worktrees/foo', { force: true, deleteBranch: 'kanban/foo' }, runner)
    expect(runner).toHaveBeenNthCalledWith(1, ['worktree', 'remove', '--force', '/repo/.switchboard/worktrees/foo'], '/repo')
    expect(runner).toHaveBeenNthCalledWith(2, ['branch', '-D', 'kanban/foo'], '/repo')
  })

  it('does NOT delete branches outside the kanban/ namespace', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await removeWorktree('/repo', '/repo/wt', { deleteBranch: 'feature/safe' }, runner)
    expect(runner).toHaveBeenCalledTimes(1) // only worktree remove, no branch -D
  })

  it('falls back to prune when remove reports the worktree is gone', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error("'/repo/wt' is not a working tree")
      return { stdout: '', stderr: '' }
    })
    await removeWorktree('/repo', '/repo/wt', {}, runner)
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[1][0]).toEqual(['worktree', 'prune'])
  })
})

describe('findStaleWorktrees', () => {
  let repoPath: string
  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'sb-stale-'))
    await mkdir(join(repoPath, WORKTREE_DIR_REL, 'live'), { recursive: true })
  })
  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('returns worktrees that are prunable, missing on disk, or unreferenced by any card', async () => {
    const livePath = join(repoPath, WORKTREE_DIR_REL, 'live')
    const goneDirPath = join(repoPath, WORKTREE_DIR_REL, 'gone')
    const orphanPath = join(repoPath, WORKTREE_DIR_REL, 'orphan')
    // 'orphan' exists on disk but no card references it.
    await mkdir(orphanPath, { recursive: true })

    const runner = vi.fn(async () => ({
      stdout: [
        `worktree ${repoPath}`,
        'HEAD aaaaaaa',
        'branch refs/heads/main',
        '',
        `worktree ${livePath}`,
        'HEAD bbbbbbb',
        'branch refs/heads/kanban/live',
        '',
        `worktree ${goneDirPath}`,
        'HEAD ccccccc',
        'branch refs/heads/kanban/gone',
        '',
        `worktree ${orphanPath}`,
        'HEAD ddddddd',
        'branch refs/heads/kanban/orphan',
        '',
      ].join('\n'),
      stderr: '',
    }))
    const inUse = new Set([livePath])
    const stale = await findStaleWorktrees(repoPath, inUse, runner)
    const stalePaths = stale.map((s) => s.path).sort()
    expect(stalePaths).toEqual([goneDirPath, orphanPath].sort())
  })
})
