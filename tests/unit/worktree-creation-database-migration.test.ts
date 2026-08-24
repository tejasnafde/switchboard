import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  getDb,
  getManagedRootConversationsForProject,
  getManagedRootConversationsForProjects,
} from '../../src/main/db/database'

const roots: string[] = []
const previousDataDir = process.env.SWITCHBOARD_DATA_DIR

afterEach(() => {
  closeDb()
  if (previousDataDir === undefined) delete process.env.SWITCHBOARD_DATA_DIR
  else process.env.SWITCHBOARD_DATA_DIR = previousDataDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('application database worktree creation migration', () => {
  it('installs the journal, catalog, and compatible owner projections on open', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-worktree-migration-'))
    roots.push(root)
    process.env.SWITCHBOARD_DATA_DIR = root

    const db = getDb()
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('managed_worktrees', 'worktree_creations')
       ORDER BY name
    `).all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(['managed_worktrees', 'worktree_creations'])

    for (const table of ['conversations', 'kanban_cards']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'worktree_id',
        'worktree_creation_id',
        'worktree_path',
        'worktree_branch',
      ]))
    }
  })

  it('lists retained owner projections for recovery while hiding other non-ready conversations', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-worktree-recovery-sidebar-'))
    roots.push(root)
    process.env.SWITCHBOARD_DATA_DIR = root
    const db = getDb()
    db.prepare(`INSERT INTO projects (path, name) VALUES ('/repo', 'repo')`).run()
    const insertCreation = db.prepare(`
      INSERT INTO worktree_creations (
        machine_id, creation_id, schema_version, request_json, payload_hash,
        phase, status, revision, recovery_json, created_at, updated_at
      ) VALUES ('machine-local', ?, 1, '{}', ?, 'provisioning', ?, 4, ?, 100, 100)
    `)
    insertCreation.run('creation-ready', 'hash-ready', 'ready', null)
    insertCreation.run('creation-retained', 'hash-retained', 'cleanup_required', JSON.stringify({ disposition: 'retained' }))
    insertCreation.run('creation-pending', 'hash-pending', 'pending', null)
    insertCreation.run('creation-corrupt', 'hash-corrupt', 'cleanup_required', '{')
    const insertConversation = db.prepare(`
      INSERT INTO conversations (
        id, project_path, agent_type, title, created_at, updated_at,
        sidebar_role, worktree_creation_id
      ) VALUES (?, '/repo', 'claude-code', ?, 100, 100, 'managed', ?)
    `)
    insertConversation.run('conversation-ready', 'Ready', 'creation-ready')
    insertConversation.run('conversation-retained', 'Recoverable', 'creation-retained')
    insertConversation.run('conversation-pending', 'Not ready', 'creation-pending')
    insertConversation.run('conversation-corrupt', 'Corrupt recovery metadata', 'creation-corrupt')

    const one = getManagedRootConversationsForProject('/repo')
    const many = getManagedRootConversationsForProjects(['/repo']).get('/repo') ?? []
    for (const rows of [one, many]) {
      expect(rows.map((row) => row.id).sort()).toEqual(['conversation-ready', 'conversation-retained'])
      expect(rows.find((row) => row.id === 'conversation-retained')).toMatchObject({
        worktree_creation_status: 'cleanup_required',
        worktree_creation_recovery_json: JSON.stringify({ disposition: 'retained' }),
      })
    }
  })
})
