import Database from 'better-sqlite3'
import type { ProjectOrganizationItem } from '@shared/types'
import { getDb } from './database'

// ─── Project CRUD ────────────────────────────────────────────────

export function addProject(path: string, name: string): void {
  getDb().prepare(
    `INSERT OR IGNORE INTO projects (path, name, sort_order)
     SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1
       FROM projects
      WHERE workspace_id IS NULL`
  ).run(path, name)
}

export function getProjects(): Array<{ path: string; name: string; added_at: number; workspace_id: string | null; sort_order: number }> {
  return getDb().prepare(
    `SELECT p.path, p.name, p.added_at, p.workspace_id, p.sort_order
       FROM projects p
       LEFT JOIN project_workspaces w ON w.id = p.workspace_id
      ORDER BY CASE WHEN p.workspace_id IS NULL THEN 1 ELSE 0 END,
               w.sort_order ASC,
               p.sort_order ASC,
               p.added_at DESC,
               p.path ASC`
  ).all() as Array<{
    path: string
    name: string
    added_at: number
    workspace_id: string | null
    sort_order: number
  }>
}

export function removeProject(path: string): void {
  const db = getDb()
  db.transaction(() => {
    const row = db.prepare('SELECT workspace_id FROM projects WHERE path = ?')
      .get(path) as { workspace_id: string | null } | undefined
    db.prepare('DELETE FROM projects WHERE path = ?').run(path)
    if (row) normalizeProjectGroup(db, row.workspace_id)
  })()
}

export function renameProject(path: string, name: string): void {
  getDb().prepare('UPDATE projects SET name = ? WHERE path = ?').run(name, path)
}

// ─── Workspace CRUD ──────────────────────────────────────────────

export interface WorkspaceRow {
  id: string
  name: string
  color: string | null
  sort_order: number
  created_at: number
}

function makeWorkspaceId(): string {
  // Uniqueness only matters within this DB; collision odds are nil.
  return 'ws_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function listWorkspaces(): WorkspaceRow[] {
  return getDb().prepare(
    'SELECT id, name, color, sort_order, created_at FROM project_workspaces ORDER BY sort_order ASC, created_at ASC'
  ).all() as WorkspaceRow[]
}

export function createWorkspace(input: { name: string; color?: string | null }): WorkspaceRow {
  const id = makeWorkspaceId()
  const now = Date.now()
  // New workspaces sort to the end. We compute max(sort_order)+1 so an
  // explicit reorder isn't needed for the first N workspaces a user adds.
  const maxRow = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_workspaces').get() as { m: number }
  const nextOrder = (maxRow?.m ?? -1) + 1
  getDb().prepare(
    'INSERT INTO project_workspaces (id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, input.name, input.color ?? null, nextOrder, now)
  return { id, name: input.name, color: input.color ?? null, sort_order: nextOrder, created_at: now }
}

export function renameWorkspace(id: string, name: string): void {
  getDb().prepare('UPDATE project_workspaces SET name = ? WHERE id = ?').run(name, id)
}

export function recolorWorkspace(id: string, color: string | null): void {
  getDb().prepare('UPDATE project_workspaces SET color = ? WHERE id = ?').run(color, id)
}

export function deleteWorkspace(id: string): void {
  const db = getDb()
  const paths = (sql: string, ...args: unknown[]) => (
    db.prepare(sql).all(...args) as Array<{ path: string }>
  ).map((row) => row.path)
  db.transaction(() => {
    const ungrouped = paths(
      'SELECT path FROM projects WHERE workspace_id IS NULL ORDER BY sort_order, added_at DESC, path'
    )
    const moving = paths(
      'SELECT path FROM projects WHERE workspace_id = ? ORDER BY sort_order, added_at DESC, path',
      id,
    )
    db.prepare('DELETE FROM project_workspaces WHERE id = ?').run(id)
    const update = db.prepare('UPDATE projects SET sort_order = ? WHERE path = ?')
    const reordered = [...ungrouped, ...moving]
    reordered.forEach((path, index) => update.run(index, path))
  })()
}

export function reorderWorkspaces(orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE project_workspaces SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id))
  })()
}

export function setProjectWorkspace(projectPath: string, workspaceId: string | null): void {
  const db = getDb()
  db.transaction(() => {
    const current = db.prepare('SELECT workspace_id FROM projects WHERE path = ?')
      .get(projectPath) as { workspace_id: string | null } | undefined
    if (!current || current.workspace_id === workspaceId) return
    const max = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS value FROM projects WHERE workspace_id IS ?'
    ).get(workspaceId) as { value: number }
    db.prepare('UPDATE projects SET workspace_id = ?, sort_order = ? WHERE path = ?')
      .run(workspaceId, max.value + 1, projectPath)
    normalizeProjectGroup(db, current.workspace_id)
    normalizeProjectGroup(db, workspaceId)
  })()
}

function normalizeProjectGroup(database: Database.Database, workspaceId: string | null): void {
  const rows = database.prepare(
    'SELECT path FROM projects WHERE workspace_id IS ? ORDER BY sort_order, added_at DESC, path'
  ).all(workspaceId) as Array<{ path: string }>
  const update = database.prepare('UPDATE projects SET sort_order = ? WHERE path = ?')
  rows.forEach((row, index) => update.run(index, row.path))
}

export function organizeProjects(items: ProjectOrganizationItem[]): void {
  const db = getDb()
  db.transaction(() => {
    const existing = db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>
    const requested = new Set(items.map((item) => item.path))
    if (requested.size !== items.length || existing.length !== items.length || existing.some((row) => !requested.has(row.path))) {
      throw new Error('Project list changed while it was being reordered')
    }
    const workspaceIds = new Set(
      (db.prepare('SELECT id FROM project_workspaces').all() as Array<{ id: string }>).map((row) => row.id),
    )
    if (items.some((item) => item.workspaceId !== null && !workspaceIds.has(item.workspaceId))) {
      throw new Error('A target workspace no longer exists')
    }
    const nextByWorkspace = new Map<string | null, number>()
    const update = db.prepare(
      'UPDATE projects SET workspace_id = ?, sort_order = ? WHERE path = ?'
    )
    items.forEach((item) => {
      const sortOrder = nextByWorkspace.get(item.workspaceId) ?? 0
      nextByWorkspace.set(item.workspaceId, sortOrder + 1)
      update.run(item.workspaceId, sortOrder, item.path)
    })
  })()
}
