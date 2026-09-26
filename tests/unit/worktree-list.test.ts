import { describe, expect, it } from 'vitest'
import type { WorktreeRow } from '../../src/shared/worktree-manager'
import {
  canBatchRemove,
  inventorySummary,
  protectedNote,
  pruneSelection,
  removeButtonLabel,
  visibleRows,
} from '../../src/renderer/components/settings/worktree-list'

function row(path: string, overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    projectPath: '/repo', projectName: 'repo', path, branch: `b/${path}`, head: 'abc', prunable: false,
    locked: false, owned: false, chat: null, protectedBy: null,
    git: { uncommittedFiles: 0, unpushedCommits: 0, merged: true },
    ...overrides,
  }
}

describe('worktree list', () => {
  const safe = row('/a')
  const changed = row('/b', { git: { uncommittedFiles: 2, unpushedCommits: 0, merged: false } })
  const inUse = row('/c', { owned: true })
  const guarded = row('/d', { protectedBy: 'project', projectName: 'bot' })

  it('lets only safe rows join a batch', () => {
    expect([safe, changed, inUse, guarded].map(canBatchRemove)).toEqual([true, false, false, false])
  })

  it('shows protected rows only when asked', () => {
    expect(visibleRows([safe, guarded], 'all', false)).toEqual([safe])
    expect(visibleRows([safe, guarded], 'all', true)).toEqual([safe, guarded])
  })

  it('drops selections that are gone or no longer safe', () => {
    const selected = new Set(['/a', '/b', '/gone'])
    expect([...pruneSelection(selected, [safe, changed])]).toEqual(['/a'])
  })

  it('shows the size only once every selected size is known', () => {
    const sizes = new Map<string, number | null>([['/a', 1024 * 1024]])
    expect(removeButtonLabel(new Set(['/a']), sizes)).toBe('Remove 1.0 MB')
    expect(removeButtonLabel(new Set(['/a', '/e']), sizes)).toBe('Remove 2')
  })

  it('says what protection hides', () => {
    expect(protectedNote([safe])).toBeNull()
    expect(protectedNote([guarded, row('/e', { protectedBy: 'project', projectName: 'bot' })])).toBe('bot is protected and hidden (2 worktrees).')
    expect(protectedNote([row('/f', { protectedBy: 'worktree' })])).toBe('1 worktree protected and hidden.')
  })

  it('summarises for the Archive & data row', () => {
    expect(inventorySummary([])).toBe('No worktrees.')
    expect(inventorySummary([safe, changed, inUse])).toBe('3 worktrees · 1 safe to remove')
  })
})
