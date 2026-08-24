import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureWorktreeCreationSchema,
  listOwnedWorktreePaths,
  SqliteWorktreeCreationStore,
} from '../../src/main/db/worktree-creation'

describe('managed worktree liveness catalog', () => {
  it('retains conflicting legacy branch aliases without creating cleanup authority', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          parent_conversation_id TEXT, worktree_path TEXT, worktree_branch TEXT
        );
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
          worktree_path TEXT, worktree_branch TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO conversations VALUES (
          'legacy-session', '/repo', 'claude-code', 'Legacy', 1, 1, NULL,
          '/repo/.switchboard/worktrees/shared', 'sb/legacy'
        );
        INSERT INTO kanban_cards VALUES (
          'legacy-card', '/repo', 'Legacy card',
          '/repo/.switchboard/worktrees/shared', 'kanban/legacy', 1, 1
        );
      `)

      ensureWorktreeCreationSchema(db)
      const first = db.prepare(`
        SELECT id, management_origin, lifecycle, provenance_json, lineage_json,
               initial_owner_kind, initial_owner_id
          FROM managed_worktrees
      `).get() as Record<string, unknown>
      const projections = db.prepare(`
        SELECT worktree_id, worktree_creation_id FROM conversations WHERE id = 'legacy-session'
        UNION ALL
        SELECT worktree_id, worktree_creation_id FROM kanban_cards WHERE id = 'legacy-card'
      `).all() as Array<{ worktree_id: string; worktree_creation_id: string }>

      expect(first).toMatchObject({
        management_origin: 'legacy_unknown',
        lifecycle: 'retained',
        lineage_json: null,
        initial_owner_kind: 'conversation',
        initial_owner_id: 'legacy-session',
      })
      expect(JSON.parse(first.provenance_json as string)).toMatchObject({ surface: 'legacy' })
      expect(projections.map((row) => row.worktree_id)).toEqual([first.id, first.id])
      expect(projections.map((row) => row.worktree_creation_id)).toEqual([null, null])
      expect(db.prepare('SELECT count(*) AS count FROM worktree_creations').get()).toEqual({ count: 0 })

      ensureWorktreeCreationSchema(db)
      expect(db.prepare('SELECT count(*) AS count FROM managed_worktrees').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT id FROM managed_worktrees').get()).toEqual({ id: first.id })
      expect(db.prepare('SELECT count(*) AS count FROM worktree_creations').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('retains a legacy path outside the canonical project worktree root without cleanup authority', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          worktree_path TEXT, worktree_branch TEXT
        );
        INSERT INTO conversations VALUES (
          'legacy-session', '/repo', 'claude-code', 'Legacy', 1, 1,
          '/managed/shared', 'sb/legacy'
        );
      `)

      ensureWorktreeCreationSchema(db)

      expect(db.prepare(`
        SELECT worktree_id, worktree_creation_id
          FROM conversations WHERE id = 'legacy-session'
      `).get()).toMatchObject({
        worktree_id: expect.stringMatching(/^legacy_/),
        worktree_creation_id: null,
      })
      expect(db.prepare('SELECT count(*) AS count FROM worktree_creations').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('detaches every legacy projection sharing a canonical worktree after explicit cleanup', () => {
    const db = new Database(':memory:')
    const projectPath = resolve('/repo')
    const worktreePath = resolve(projectPath, '.switchboard', 'worktrees', 'shared')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          worktree_path TEXT, worktree_branch TEXT
        );
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
          worktree_path TEXT, worktree_branch TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      db.prepare(`
        INSERT INTO conversations VALUES (
          'legacy-session', ?, 'claude-code', 'Legacy', 1, 1, ?, 'sb/legacy'
        )
      `).run(projectPath, worktreePath)
      db.prepare(`
        INSERT INTO kanban_cards VALUES (
          'legacy-card', ?, 'Legacy card', ?, 'sb/legacy', 2, 2
        )
      `).run(projectPath, worktreePath)
      ensureWorktreeCreationSchema(db)
      const key = db.prepare(`
        SELECT worktree_creation_id AS creationId FROM conversations WHERE id = 'legacy-session'
      `).get() as { creationId: string }
      db.prepare(`
        UPDATE kanban_cards
           SET worktree_creation_id = 'different-creation'
         WHERE id = 'legacy-card'
      `).run()
      const store = new SqliteWorktreeCreationStore(db)
      const current = store.get({ machineId: 'local', creationId: key.creationId })
      expect(current).not.toBeNull()

      expect(store.finalizeCleanup({
        machineId: 'local',
        creationId: key.creationId,
        expectedRevision: current!.revision,
        disposition: 'removed',
        now: 10,
      })).toMatchObject({ kind: 'updated', record: { status: 'rolled_back' } })

      expect(db.prepare(`
        SELECT worktree_path, worktree_branch, worktree_id, worktree_creation_id
          FROM conversations WHERE id = 'legacy-session'
      `).get()).toEqual({
        worktree_path: null,
        worktree_branch: null,
        worktree_id: null,
        worktree_creation_id: null,
      })
      expect(db.prepare(`
        SELECT worktree_path, worktree_branch, worktree_id, worktree_creation_id
          FROM kanban_cards WHERE id = 'legacy-card'
      `).get()).toEqual({
        worktree_path: null,
        worktree_branch: null,
        worktree_id: null,
        worktree_creation_id: null,
      })
    } finally {
      db.close()
    }
  })

  it('only revisits unlinked projections while still discovering later legacy writes', () => {
    const db = new Database(':memory:')
    const projectPath = resolve('/repo')
    const laterWorktreePath = resolve(projectPath, '.switchboard', 'worktrees', 'later')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          worktree_path TEXT, worktree_branch TEXT
        );
      `)
      ensureWorktreeCreationSchema(db)
      db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          created_at, updated_at
        ) VALUES ('external-worktree', 'local', '/repo/.git', '/repo',
          '/repo/.switchboard/worktrees/already-linked', 'sb/already-linked', 'HEAD', ?,
          'legacy_unknown', 'retained', 'conversation', 'already-linked', 'new-chat', '{}', 1, 1)
      `).run('0'.repeat(40))
      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          worktree_path, worktree_branch, worktree_id
        ) VALUES ('already-linked', '/repo', 'claude-code', 'Linked', 1, 1,
          '/repo/.switchboard/worktrees/already-linked', 'sb/already-linked', 'external-worktree')
      `).run()

      ensureWorktreeCreationSchema(db)
      expect(db.prepare(`
        SELECT worktree_creation_id FROM conversations WHERE id = 'already-linked'
      `).get()).toEqual({ worktree_creation_id: null })
      expect(db.prepare('SELECT count(*) AS count FROM worktree_creations').get()).toEqual({ count: 0 })

      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          worktree_path, worktree_branch
        ) VALUES ('later-legacy', ?, 'claude-code', 'Later', 2, 2, ?, 'sb/later')
      `).run(projectPath, laterWorktreePath)
      ensureWorktreeCreationSchema(db)

      expect(db.prepare(`
        SELECT worktree_id, worktree_creation_id
          FROM conversations WHERE id = 'later-legacy'
      `).get()).toMatchObject({
        worktree_id: expect.stringMatching(/^legacy_/),
        worktree_creation_id: expect.stringMatching(/^legacy_cleanup_/),
      })
      expect(db.prepare('SELECT count(*) AS count FROM worktree_creations').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  it('revokes synthetic cleanup authority when a later legacy alias reveals a branch conflict', () => {
    const db = new Database(':memory:')
    const projectPath = resolve('/repo')
    const worktreePath = resolve(projectPath, '.switchboard', 'worktrees', 'shared')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          worktree_path TEXT, worktree_branch TEXT
        );
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
          worktree_path TEXT, worktree_branch TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      db.prepare(`
        INSERT INTO conversations VALUES (
          'legacy-session', ?, 'claude-code', 'Legacy', 1, 1, ?, 'sb/legacy'
        )
      `).run(projectPath, worktreePath)
      ensureWorktreeCreationSchema(db)
      const original = db.prepare(`
        SELECT worktree_id, worktree_creation_id
          FROM conversations WHERE id = 'legacy-session'
      `).get() as { worktree_id: string; worktree_creation_id: string }
      expect(original.worktree_creation_id).toMatch(/^legacy_cleanup_/)

      db.prepare(`
        INSERT INTO kanban_cards (
          id, project_path, title, worktree_path, worktree_branch, created_at, updated_at
        ) VALUES ('later-card', ?, 'Later', ?, 'kanban/conflict', 2, 2)
      `).run(projectPath, worktreePath)
      ensureWorktreeCreationSchema(db)

      expect(db.prepare(`
        SELECT worktree_id, worktree_creation_id FROM conversations WHERE id = 'legacy-session'
        UNION ALL
        SELECT worktree_id, worktree_creation_id FROM kanban_cards WHERE id = 'later-card'
      `).all()).toEqual([
        { worktree_id: original.worktree_id, worktree_creation_id: null },
        { worktree_id: original.worktree_id, worktree_creation_id: null },
      ])
      expect(db.prepare(`
        SELECT status, materialization_plan_json
          FROM worktree_creations WHERE creation_id = ?
      `).get(original.worktree_creation_id)).toEqual({
        status: 'cancelled',
        materialization_plan_json: null,
      })
    } finally {
      db.close()
    }
  })

  it('protects canonical, conversation, fork, and kanban projections from stale cleanup', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          parent_conversation_id TEXT, worktree_path TEXT, worktree_branch TEXT
        );
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
          worktree_path TEXT, worktree_branch TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      ensureWorktreeCreationSchema(db)
      db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          created_at, updated_at
        ) VALUES (?, 'local', '/repo/.git', '/repo', ?, 'sb/catalog', 'HEAD', ?,
          'managed', 'active', 'conversation', 'catalog-owner', 'new-chat', '{}', 1, 1)
      `).run('catalog-worktree', '/managed/catalog', '0'.repeat(40))
      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          parent_conversation_id, worktree_path, worktree_branch
        ) VALUES (?, '/repo', 'claude-code', ?, 1, 1, ?, ?, ?)
      `).run('session-owner', 'Session', null, '/managed/session', 'sb/session')
      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          parent_conversation_id, worktree_path, worktree_branch
        ) VALUES (?, '/repo', 'claude-code', ?, 1, 1, ?, ?, ?)
      `).run('fork-owner', 'Fork', 'parent', '/managed/fork', 'fork/topic')
      db.prepare(`
        INSERT INTO kanban_cards (
          id, project_path, title, worktree_path, worktree_branch, created_at, updated_at
        ) VALUES ('card-owner', '/repo', 'Card', '/managed/card', 'kanban/card', 1, 1)
      `).run()

      expect(listOwnedWorktreePaths(db, '/repo')).toEqual(new Set([
        '/managed/catalog',
        '/managed/session',
        '/managed/fork',
        '/managed/card',
      ]))
    } finally {
      db.close()
    }
  })

  it('does not keep removed catalog records or projections belonging to another project alive', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
          title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          worktree_path TEXT, worktree_branch TEXT
        );
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
          worktree_path TEXT, worktree_branch TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      ensureWorktreeCreationSchema(db)
      db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          created_at, updated_at
        ) VALUES ('removed', 'local', '/repo/.git', '/repo', '/managed/removed',
          'sb/removed', 'HEAD', ?, 'managed', 'removed', 'conversation', 'owner',
          'new-chat', '{}', 1, 1)
      `).run('0'.repeat(40))
      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          worktree_path, worktree_branch
        ) VALUES ('other', '/other', 'claude-code', 'Other', 1, 1, '/managed/other', 'sb/other')
      `).run()

      expect(listOwnedWorktreePaths(db, '/repo')).toEqual(new Set())
    } finally {
      db.close()
    }
  })

  it('protects reserved paths while a durable creation has not committed its owner yet', () => {
    const db = new Database(':memory:')
    try {
      ensureWorktreeCreationSchema(db)
      db.prepare(`
        INSERT INTO worktree_creations (
          machine_id, creation_id, schema_version, request_json, payload_hash,
          phase, status, revision, reserved_path, created_at, updated_at
        ) VALUES ('local', 'creating', 1, ?, 'hash', 'materializing', 'pending', 2,
          '/managed/reserved', 1, 1)
      `).run(JSON.stringify({ repository: { projectPath: '/repo' } }))

      expect(listOwnedWorktreePaths(db, '/repo')).toContain('/managed/reserved')
    } finally {
      db.close()
    }
  })
})
