/**
 * Pure helpers for the offline cache: relative "synced ago" label and shaping a
 * stored snapshot into the read-only display list.
 */
import { describe, it, expect } from 'vitest'
import { syncedAgoLabel, cachedProjects, projectsToSnapshot } from '../../src/renderer/components/sidebar/machineSnapshot'
import type { MachineSnapshot } from '@shared/machines'
import type { Project } from '@shared/types'

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

describe('projectsToSnapshot', () => {
  it('trims a live project list to the cached path/name/session shape', () => {
    const projects = [
      {
        path: '/r/api', name: 'api', workspaceId: null,
        sessions: [
          { id: 's1', source: 'claude-code', title: 'fix bug', startedAt: 0, messageCount: 3, filePath: '/x' },
          { id: 's2', source: 'codex', title: 'refactor', startedAt: 0, messageCount: 1, filePath: '/y' },
        ],
      },
    ] as Project[]
    const snap = projectsToSnapshot(projects, 1234)
    expect(snap.syncedAt).toBe(1234)
    expect(snap.projects).toEqual([
      { path: '/r/api', name: 'api', sessions: [{ id: 's1', title: 'fix bug' }, { id: 's2', title: 'refactor' }] },
    ])
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
