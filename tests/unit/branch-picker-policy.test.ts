/**
 * Pure ranking + filtering for the per-thread branch picker popover.
 * Keeping this separate from the React component means the
 * "current first, then locals, then remotes; substring-match the query"
 * rules are testable without a DOM.
 */
import { describe, expect, it } from 'vitest'
import {
  rankAndFilterRefs,
  decideSwitchAction,
  type Ref,
} from '../../src/renderer/components/chat/branchPickerPolicy'

const refs: Ref[] = [
  { name: 'main', sha: 'a', current: true, isRemote: false, worktreePath: null },
  { name: 'feat/foo', sha: 'b', current: false, isRemote: false, worktreePath: null },
  { name: 'feat/bar', sha: 'c', current: false, isRemote: false, worktreePath: '/wt/bar' },
  { name: 'origin/main', sha: 'a', current: false, isRemote: true, worktreePath: null },
  { name: 'origin/feature', sha: 'd', current: false, isRemote: true, worktreePath: null },
]

describe('rankAndFilterRefs — ordering', () => {
  it('puts the current branch first', () => {
    const out = rankAndFilterRefs(refs, '')
    expect(out[0].name).toBe('main')
  })

  it('lists local refs before remote refs', () => {
    const out = rankAndFilterRefs(refs, '')
    const localCount = out.filter((r) => !r.isRemote).length
    // The first localCount entries should all be local; everything after, remote
    expect(out.slice(0, localCount).every((r) => !r.isRemote)).toBe(true)
    expect(out.slice(localCount).every((r) => r.isRemote)).toBe(true)
  })

  it('keeps stable alphabetical order within each group', () => {
    const out = rankAndFilterRefs(refs, '')
    // First the current `main`, then locals alphabetical (feat/bar, feat/foo),
    // then remotes alphabetical (origin/feature, origin/main).
    expect(out.map((r) => r.name)).toEqual([
      'main',
      'feat/bar',
      'feat/foo',
      'origin/feature',
      'origin/main',
    ])
  })
})

describe('rankAndFilterRefs — filtering', () => {
  it('substring-matches branch names case-insensitively, across locals + remotes', () => {
    // 'FEAT' matches 'feat/bar', 'feat/foo' (locals) AND 'origin/feature'
    // (remote — contains the substring inside "feature"). The user
    // explicitly typed a substring; hiding remote matches would be
    // surprising. Ordering still respects the locals-before-remotes rule.
    const out = rankAndFilterRefs(refs, 'FEAT')
    expect(out.map((r) => r.name)).toEqual(['feat/bar', 'feat/foo', 'origin/feature'])
  })

  it('returns the empty list when nothing matches', () => {
    expect(rankAndFilterRefs(refs, 'nope')).toEqual([])
  })

  it('treats whitespace-only queries as no filter', () => {
    const out = rankAndFilterRefs(refs, '   ')
    expect(out).toHaveLength(refs.length)
  })

  it('preserves the current-first ordering even when the current branch matches the filter', () => {
    const out = rankAndFilterRefs(refs, 'main')
    expect(out[0].name).toBe('main')
    expect(out[1].name).toBe('origin/main')
  })
})

describe('decideSwitchAction', () => {
  const localNoWorktree: Ref = {
    name: 'feat/x', sha: 'a', current: false, isRemote: false, worktreePath: null,
  }
  const localWithWorktree: Ref = {
    name: 'feat/y', sha: 'b', current: false, isRemote: false, worktreePath: '/wt/y',
  }
  const currentBranch: Ref = {
    name: 'main', sha: 'c', current: true, isRemote: false, worktreePath: null,
  }
  const remote: Ref = {
    name: 'origin/feat', sha: 'd', current: false, isRemote: true, worktreePath: null,
  }

  it('returns noop when picking the already-checked-out current branch', () => {
    expect(decideSwitchAction(currentBranch, '/repo')).toEqual({ kind: 'noop' })
  })

  it('returns checkout for a local branch with no worktree', () => {
    expect(decideSwitchAction(localNoWorktree, '/repo')).toEqual({
      kind: 'checkout',
      cwd: '/repo',
      refName: 'feat/x',
    })
  })

  it('returns swap-cwd to the existing worktree path when the picked branch lives in one', () => {
    expect(decideSwitchAction(localWithWorktree, '/repo')).toEqual({
      kind: 'swap-cwd',
      newCwd: '/wt/y',
      refName: 'feat/y',
    })
  })

  it('returns noop when the current cwd is already the picked branch’s worktree', () => {
    expect(decideSwitchAction(localWithWorktree, '/wt/y')).toEqual({ kind: 'noop' })
  })

  it('strips the leading remote name when checking out a remote ref (origin/feat → feat)', () => {
    // Picking `origin/feat` should `git checkout feat` so we land on a
    // local tracking branch, not an explicit remote ref (which leaves
    // us in detached HEAD on most git versions).
    expect(decideSwitchAction(remote, '/repo')).toEqual({
      kind: 'checkout',
      cwd: '/repo',
      refName: 'feat',
    })
  })
})
