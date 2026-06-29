/**
 * Pure helpers for the offline cache: relative "synced ago" label and shaping a
 * stored snapshot into the read-only display list.
 */
import { describe, it, expect } from 'vitest'
import { syncedAgoLabel, cachedProjects } from '../../src/renderer/components/sidebar/machineSnapshot'
import type { MachineSnapshot } from '@shared/machines'

describe('syncedAgoLabel', () => {
  const now = 1_000_000_000_000
  it('shows seconds under a minute', () => {
    expect(syncedAgoLabel(now - 5_000, now)).toBe('synced just now')
    expect(syncedAgoLabel(now - 45_000, now)).toBe('synced just now')
  })
  it('shows minutes under an hour', () => {
    expect(syncedAgoLabel(now - 5 * 60_000, now)).toBe('synced 5m ago')
  })
  it('shows hours under a day', () => {
    expect(syncedAgoLabel(now - 3 * 3_600_000, now)).toBe('synced 3h ago')
  })
  it('shows days otherwise', () => {
    expect(syncedAgoLabel(now - 2 * 86_400_000, now)).toBe('synced 2d ago')
  })
  it('returns empty when never synced', () => {
    expect(syncedAgoLabel(undefined, now)).toBe('')
  })
})

describe('cachedProjects', () => {
  it('returns [] for a missing snapshot', () => {
    expect(cachedProjects(undefined)).toEqual([])
  })
  it('passes through the stored projects', () => {
    const snap: MachineSnapshot = {
      syncedAt: 1,
      projects: [
        { path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 'fix bug' }] },
        { path: '/r/web', name: 'web', sessions: [] },
      ],
    }
    expect(cachedProjects(snap).map((p) => p.name)).toEqual(['api', 'web'])
    expect(cachedProjects(snap)[0].sessions[0].title).toBe('fix bug')
  })
})
