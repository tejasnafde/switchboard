import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deriveProjectPositions } from '../../src/main/db/projectOrdering'

describe('deriveProjectPositions', () => {
  it('migrates a global saved order into contiguous positions per workspace', () => {
    const positions = deriveProjectPositions([
      { path: '/a', workspaceId: 'one', addedAt: 10 },
      { path: '/b', workspaceId: 'one', addedAt: 30 },
      { path: '/c', workspaceId: 'two', addedAt: 20 },
      { path: '/d', workspaceId: null, addedAt: 5 },
    ], ['/c', '/a', '/missing'])

    expect(positions).toEqual([
      { path: '/c', workspaceId: 'two', sortOrder: 0 },
      { path: '/a', workspaceId: 'one', sortOrder: 0 },
      { path: '/b', workspaceId: 'one', sortOrder: 1 },
      { path: '/d', workspaceId: null, sortOrder: 0 },
    ])
  })

  it('uses newest-first then path as the deterministic fallback', () => {
    const positions = deriveProjectPositions([
      { path: '/b', workspaceId: null, addedAt: 10 },
      { path: '/c', workspaceId: null, addedAt: 20 },
      { path: '/a', workspaceId: null, addedAt: 10 },
    ], null)

    expect(positions.map((position) => position.path)).toEqual(['/c', '/a', '/b'])
    expect(positions.map((position) => position.sortOrder)).toEqual([0, 1, 2])
  })

  it('ignores malformed and duplicate saved paths', () => {
    const rows = [
      { path: '/a', workspaceId: null, addedAt: 1 },
      { path: '/b', workspaceId: null, addedAt: 2 },
    ]
    expect(deriveProjectPositions(rows, ['/a', '/a', 5] as unknown as string[]).map((item) => item.path))
      .toEqual(['/a', '/b'])
    expect(deriveProjectPositions(rows, 'bad' as unknown as string[]).map((item) => item.path))
      .toEqual(['/b', '/a'])
  })
})

describe('project ordering database contract', () => {
  const source = readFileSync(new URL('../../src/main/db/database.ts', import.meta.url), 'utf8')

  it('migrates the compatibility setting and serves canonical database order', () => {
    expect(source).toContain("SELECT value FROM settings WHERE key = 'projectOrder'")
    expect(source).toMatch(/ALTER TABLE projects ADD COLUMN sort_order/)
    expect(source).toMatch(/ORDER BY CASE WHEN p\.workspace_id IS NULL[\s\S]*?p\.sort_order ASC/)
  })

  it('validates and rewrites the complete project organization in one transaction', () => {
    const organizer = source.slice(
      source.indexOf('export function organizeProjects'),
      source.indexOf('// ─── Conversation CRUD'),
    )
    expect(organizer).toContain('db.transaction')
    expect(organizer).toContain('Project list changed while it was being reordered')
    expect(organizer).toContain('UPDATE projects SET workspace_id = ?, sort_order = ?')
  })
})
