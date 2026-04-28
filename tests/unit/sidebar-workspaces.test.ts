import { describe, it, expect } from 'vitest'
import {
  groupProjectsByWorkspace,
  applySidebarFilter,
  colorTokenForWorkspace,
} from '../../src/renderer/components/sidebar/sidebar-helpers'
import type { Project, SessionSummary, Workspace } from '../../src/shared/types'

/**
 * Pure-helper tests for the workspace sidebar. The helpers are extracted
 * from Sidebar.tsx so we can pin grouping + filter behavior without
 * dragging in dnd-kit / zustand / the renderer at all.
 */

const sess = (id: string, title: string): SessionSummary => ({
  id,
  source: 'claude',
  title,
  startedAt: 0,
  messageCount: 0,
  filePath: '',
})

const proj = (path: string, workspaceId: string | null, sessions: SessionSummary[]): Project => ({
  path,
  name: path.split('/').pop() ?? path,
  sessions,
  workspaceId,
})

const ws = (id: string, name: string, sortOrder = 0, color: string | null = null): Workspace => ({
  id, name, sortOrder, color, createdAt: 0,
})

describe('groupProjectsByWorkspace', () => {
  it('partitions projects into workspace groups in sortOrder', () => {
    const projects = [
      proj('/a', 'w2', [sess('s1', 'one')]),
      proj('/b', 'w1', [sess('s2', 'two')]),
      proj('/c', null, [sess('s3', 'three')]),
    ]
    const workspaces = [ws('w1', 'First', 0), ws('w2', 'Second', 1)]
    const groups = groupProjectsByWorkspace(projects, workspaces)
    expect(groups).toHaveLength(3) // w1, w2, ungrouped
    expect(groups[0].workspace?.id).toBe('w1')
    expect(groups[0].projects.map((p) => p.path)).toEqual(['/b'])
    expect(groups[1].workspace?.id).toBe('w2')
    expect(groups[1].projects.map((p) => p.path)).toEqual(['/a'])
    expect(groups[2].workspace).toBeNull()
    expect(groups[2].projects.map((p) => p.path)).toEqual(['/c'])
  })

  it('omits the Ungrouped group entirely when every project has a workspace', () => {
    const projects = [proj('/a', 'w1', [])]
    const groups = groupProjectsByWorkspace(projects, [ws('w1', 'X')])
    expect(groups).toHaveLength(1)
    expect(groups[0].workspace?.id).toBe('w1')
  })

  it('treats stale workspace_id as ungrouped (defensive against deleted workspaces)', () => {
    const projects = [proj('/a', 'ghost-id', [sess('s1', 'a')])]
    const groups = groupProjectsByWorkspace(projects, [])
    expect(groups).toHaveLength(1)
    expect(groups[0].workspace).toBeNull()
    expect(groups[0].projects).toHaveLength(1)
  })
})

describe('applySidebarFilter', () => {
  const projects = [
    proj('/a', 'w1', [sess('s1', 'fix login bug'), sess('s2', 'release notes')]),
    proj('/b', 'w1', [sess('s3', 'rename refactor')]),
    proj('/c', null, [sess('s4', 'unrelated chat')]),
  ]
  const workspaces = [ws('w1', 'Work', 0)]
  const groups = groupProjectsByWorkspace(projects, workspaces)

  it('returns the input tree unchanged on empty query', () => {
    const out = applySidebarFilter('   ', groups)
    expect(out.groups).toBe(groups)
    expect(out.matchCount).toBe(-1)
    expect(out.expandWorkspaces.size).toBe(0)
    expect(out.expandProjects.size).toBe(0)
  })

  it('filters sessions by case-insensitive substring on the title', () => {
    const out = applySidebarFilter('BUG', groups)
    expect(out.matchCount).toBe(1)
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0].workspace?.id).toBe('w1')
    expect(out.groups[0].projects).toHaveLength(1)
    expect(out.groups[0].projects[0].sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('drops projects with no surviving sessions, drops workspaces with no surviving projects', () => {
    const out = applySidebarFilter('refactor', groups)
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0].projects).toHaveLength(1)
    expect(out.groups[0].projects[0].path).toBe('/b')
  })

  it('records ancestors to auto-expand and reports matchCount', () => {
    const out = applySidebarFilter('release', groups)
    expect(out.expandWorkspaces.has('w1')).toBe(true)
    expect(out.expandProjects.has('/a')).toBe(true)
    expect(out.matchCount).toBe(1)
  })

  it('uses the __ungrouped__ sentinel when the matching project is in Ungrouped', () => {
    const out = applySidebarFilter('unrelated', groups)
    expect(out.expandWorkspaces.has('__ungrouped__')).toBe(true)
    expect(out.groups[0].workspace).toBeNull()
  })

  it('returns matchCount=0 when nothing matches', () => {
    const out = applySidebarFilter('zzznothing', groups)
    expect(out.matchCount).toBe(0)
    expect(out.groups).toHaveLength(0)
  })
})

describe('colorTokenForWorkspace', () => {
  it('returns the explicit color when set', () => {
    expect(colorTokenForWorkspace(ws('a', 'A', 0, 'var(--workspace-color-3)'))).toBe('var(--workspace-color-3)')
  })

  it('falls back to a deterministic --workspace-color-N from the id hash', () => {
    const a = colorTokenForWorkspace(ws('abc', 'A'))
    const b = colorTokenForWorkspace(ws('abc', 'A'))
    expect(a).toBe(b) // determinism
    expect(a).toMatch(/var\(--workspace-color-[1-6]\)/)
  })
})
