import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeWorktreeCreationIdentity,
  canonicalizeWorktreeCreationRequest,
  type WorktreeCreationRequest,
} from '../../src/shared/worktree-creation'
import {
  ensureWorktreeCreationSchema,
  getKanbanWorktreeCreationKey,
  SqliteWorktreeCreationStore,
} from '../../src/main/db/worktree-creation'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1A',
    repository: {
      projectPath: '/Users/example/code/switchboard',
      machineId: 'machine-local',
    },
    checkout: {
      baseRef: 'origin/main',
      branch: { namespace: 'sb', seed: 'transactional worktree' },
      location: 'managed-user-data',
    },
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-1',
      agentType: 'claude-code',
      title: 'Transactional worktree',
    },
    purpose: 'new-chat',
    setup: { policy: 'inherit' },
    provenance: {
      surface: 'desktop',
      machineId: 'machine-local',
      requestedAt: 1_787_523_600_000,
    },
    ...overrides,
  }
}

function reservationInput(value: WorktreeCreationRequest, now = 1_000) {
  const requestJson = canonicalizeWorktreeCreationRequest(value)
  return {
    machineId: value.repository.machineId,
    creationId: value.creationId,
    schemaVersion: value.schemaVersion,
    requestJson,
    payloadHash: createHash('sha256')
      .update(canonicalizeWorktreeCreationIdentity(value))
      .digest('hex'),
    now,
  }
}

function withStore<T>(run: (db: Database.Database, store: SqliteWorktreeCreationStore) => T): T {
  const db = new Database(':memory:')
  try {
    ensureWorktreeCreationSchema(db)
    return run(db, new SqliteWorktreeCreationStore(db))
  } finally {
    db.close()
  }
}

function ensureLegacyOwnerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      worktree_path TEXT,
      worktree_branch TEXT,
      sidebar_role TEXT
    );

    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      worktree_path TEXT,
      worktree_branch TEXT
    );
  `)
}

function conversationCommitInput(expectedRevision = 1, now = 2_000) {
  return {
    machineId: 'machine-local',
    creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1A',
    expectedRevision,
    worktree: {
      id: 'worktree-1',
      repositoryId: '/Users/example/code/switchboard/.git',
      projectPath: '/Users/example/code/switchboard',
      worktreePath: '/Users/example/Library/Switchboard/worktrees/worktree-1',
      branch: 'sb/transactional-worktree-create_01HZY7W',
      requestedBaseRef: 'origin/main',
      resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    conversation: {
      id: 'conversation-1',
      projectPath: '/Users/example/code/switchboard',
      agentType: 'claude-code',
      title: 'Transactional worktree',
    },
    now,
  }
}

describe('SqliteWorktreeCreationStore', () => {
  it('ensures the worktree catalog and creation journal on real SQLite', () => {
    const db = new Database(':memory:')
    try {
      ensureWorktreeCreationSchema(db)

      const tables = db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('managed_worktrees', 'worktree_creations')
         ORDER BY name
      `).all() as Array<{ name: string }>
      expect(tables.map((row) => row.name)).toEqual([
        'managed_worktrees',
        'worktree_creations',
      ])

      const creationColumns = db.prepare('PRAGMA table_info(worktree_creations)').all() as Array<{
        name: string
        pk: number
      }>
      expect(creationColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'machine_id', pk: 1 }),
        expect.objectContaining({ name: 'creation_id', pk: 2 }),
        expect.objectContaining({ name: 'schema_version' }),
        expect.objectContaining({ name: 'request_json' }),
        expect.objectContaining({ name: 'payload_hash' }),
        expect.objectContaining({ name: 'phase' }),
        expect.objectContaining({ name: 'status' }),
        expect.objectContaining({ name: 'revision' }),
      ]))
    } finally {
      db.close()
    }
  })

  it('adds nullable canonical linkage to legacy owner tables without replacing compatibility projections', () => {
    const db = new Database(':memory:')
    try {
      ensureLegacyOwnerTables(db)

      ensureWorktreeCreationSchema(db)

      for (const table of ['conversations', 'kanban_cards']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string
          notnull: number
        }>
        expect(columns).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'worktree_id', notnull: 0 }),
          expect.objectContaining({ name: 'worktree_creation_id', notnull: 0 }),
          expect.objectContaining({ name: 'worktree_path' }),
          expect.objectContaining({ name: 'worktree_branch' }),
        ]))
      }
    } finally {
      db.close()
    }
  })

  it('returns the pending canonical record when the same creation is reserved twice', () => {
    withStore((_db, store) => {
      const input = reservationInput(request())

      const first = store.reserve(input)
      const duplicate = store.reserve(input)

      expect(first).toMatchObject({
        kind: 'reserved',
        record: { phase: 'pending', status: 'pending', revision: 1 },
      })
      expect(duplicate).toEqual({ kind: 'duplicate', record: first.record })
    })
  })

  it('finds a failed Kanban reservation before a worktree id has been materialized', () => {
    const db = new Database(':memory:')
    try {
      ensureLegacyOwnerTables(db)
      ensureWorktreeCreationSchema(db)
      const store = new SqliteWorktreeCreationStore(db)
      const value = request({
        owner: {
          kind: 'kanban-card',
          cardId: 'card-failed',
          create: { title: 'Failed reservation' },
        },
        purpose: 'kanban',
        checkout: {
          baseRef: 'origin/main',
          branch: { namespace: 'kanban', seed: 'Failed reservation' },
          location: 'managed-in-repo',
        },
      })
      const input = {
        ...reservationInput(value),
        worktreeId: 'reserved-worktree-id',
      }
      const reserved = store.reserve(input)
      expect(reserved.kind).toBe('reserved')
      if (reserved.kind !== 'reserved') throw new Error('expected reservation')
      db.prepare(`
        INSERT INTO kanban_cards (
          id, project_path, title, worktree_path, worktree_branch, worktree_creation_id
        ) VALUES ('card-failed', ?, 'Failed reservation', NULL, NULL, ?)
      `).run(value.repository.projectPath, value.creationId)
      const failed = store.transition({
        machineId: input.machineId,
        creationId: input.creationId,
        expectedRevision: reserved.record.revision,
        phase: 'materializing',
        status: 'failed',
        now: 2_000,
      })
      expect(failed.kind).toBe('updated')

      expect(getKanbanWorktreeCreationKey(db, 'card-failed')).toEqual({
        machineId: input.machineId,
        creationId: input.creationId,
      })
      db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          created_at, updated_at
        ) VALUES (
          'different-worktree', 'machine-local', '/repo/.git', ?, '/managed/different',
          'kanban/different', 'HEAD', ?, 'managed', 'active', 'kanban-card',
          'card-failed', 'kanban', '{}', 1, 1
        )
      `).run(value.repository.projectPath, '0'.repeat(40))
      db.prepare(`UPDATE kanban_cards SET worktree_id = 'different-worktree' WHERE id = 'card-failed'`).run()
      expect(getKanbanWorktreeCreationKey(db, 'card-failed')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('returns a conflict when the same machine and creation id carry a changed payload', () => {
    withStore((_db, store) => {
      const original = request()
      const changed = request({
        owner: {
          kind: 'conversation',
          conversationId: 'conversation-1',
          agentType: 'claude-code',
          title: 'A different title',
        },
      })
      const first = store.reserve(reservationInput(original))

      const conflict = store.reserve(reservationInput(changed, 2_000))

      expect(conflict).toEqual({ kind: 'conflict', record: first.record })
    })
  })

  it('round-trips the exact pending creation record', () => {
    withStore((_db, store) => {
      const input = reservationInput(request())
      const reserved = store.reserve(input)

      const stored = store.get({
        machineId: input.machineId,
        creationId: input.creationId,
      })

      expect(stored).toEqual(reserved.record)
      expect(stored).toMatchObject({
        machineId: input.machineId,
        creationId: input.creationId,
        schemaVersion: 1,
        requestJson: input.requestJson,
        payloadHash: input.payloadHash,
        phase: 'pending',
        status: 'pending',
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
    })
  })

  it('reserves immutable worktree identity and the full materialization plan before Git', () => {
    withStore((_db, store) => {
      const input = {
        ...reservationInput(request()),
        worktreeId: 'worktree-1',
        reservedPath: '/repo/.switchboard/worktrees/worktree-1',
        reservedBranch: 'sb/worktree-1',
        requestedBaseRef: 'HEAD',
        resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
        materializationPlanJson: JSON.stringify({
          repository: {
            repositoryId: '/repo/.git',
            commonGitDir: '/repo/.git',
            projectPath: '/repo',
          },
          creationId: request().creationId,
          requestedBaseRef: 'HEAD',
          resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
          branch: 'sb/worktree-1',
          worktreePath: '/repo/.switchboard/worktrees/worktree-1',
          managedRoot: '/repo/.switchboard/worktrees',
          containmentRoot: '/repo',
        }),
      }

      const reserved = store.reserve(input)

      expect(reserved.record).toMatchObject({
        worktreeId: 'worktree-1',
        reservedPath: input.reservedPath,
        reservedBranch: input.reservedBranch,
        requestedBaseRef: input.requestedBaseRef,
        resolvedBaseCommit: input.resolvedBaseCommit,
        materializationPlanJson: input.materializationPlanJson,
      })
    })
  })

  it('compare-and-swaps a transition and rejects a stale expected revision', () => {
    withStore((_db, store) => {
      const input = reservationInput(request())
      store.reserve(input)

      const updated = store.transition({
        machineId: input.machineId,
        creationId: input.creationId,
        expectedRevision: 1,
        phase: 'materializing',
        status: 'pending',
        now: 2_000,
      })
      const stale = store.transition({
        machineId: input.machineId,
        creationId: input.creationId,
        expectedRevision: 1,
        phase: 'configuring',
        status: 'pending',
        now: 3_000,
      })

      expect(updated).toMatchObject({
        kind: 'updated',
        record: {
          phase: 'materializing',
          status: 'pending',
          revision: 2,
          updatedAt: 2_000,
        },
      })
      expect(stale).toEqual({ kind: 'stale', record: updated.record })
      expect(store.get({ machineId: input.machineId, creationId: input.creationId }))
        .toEqual(updated.record)
    })
  })

  it('atomically creates a managed worktree and conversation owner projection before becoming ready', () => {
    const db = new Database(':memory:')
    try {
      ensureLegacyOwnerTables(db)
      ensureWorktreeCreationSchema(db)
      const store = new SqliteWorktreeCreationStore(db)
      const input = reservationInput(request())
      store.reserve(input)

      const linked = store.commitConversationOwner(conversationCommitInput())

      expect(linked).toMatchObject({
        kind: 'committed',
        record: {
          worktreeId: 'worktree-1',
          phase: 'linking',
          status: 'pending',
          revision: 2,
        },
      })
      expect(db.prepare(`
        SELECT id, machine_id, repository_id, project_path, worktree_path,
               branch, requested_base_ref, resolved_base_commit, lifecycle,
               initial_owner_kind, initial_owner_id, purpose
          FROM managed_worktrees WHERE id = 'worktree-1'
      `).get()).toEqual({
        id: 'worktree-1',
        machine_id: 'machine-local',
        repository_id: '/Users/example/code/switchboard/.git',
        project_path: '/Users/example/code/switchboard',
        worktree_path: '/Users/example/Library/Switchboard/worktrees/worktree-1',
        branch: 'sb/transactional-worktree-create_01HZY7W',
        requested_base_ref: 'origin/main',
        resolved_base_commit: '0123456789abcdef0123456789abcdef01234567',
        lifecycle: 'active',
        initial_owner_kind: 'conversation',
        initial_owner_id: 'conversation-1',
        purpose: 'new-chat',
      })
      expect(db.prepare(`
        SELECT project_path, worktree_id, worktree_creation_id, sidebar_role,
               worktree_path, worktree_branch
          FROM conversations WHERE id = 'conversation-1'
      `).get()).toEqual({
        project_path: '/Users/example/code/switchboard',
        worktree_id: 'worktree-1',
        worktree_creation_id: input.creationId,
        sidebar_role: 'managed',
        worktree_path: '/Users/example/Library/Switchboard/worktrees/worktree-1',
        worktree_branch: 'sb/transactional-worktree-create_01HZY7W',
      })

      const ready = store.transition({
        machineId: input.machineId,
        creationId: input.creationId,
        expectedRevision: linked.record.revision,
        phase: 'ready',
        status: 'ready',
        now: 3_000,
      })
      expect(ready).toMatchObject({
        kind: 'updated',
        record: { worktreeId: 'worktree-1', phase: 'ready', status: 'ready', revision: 3 },
      })
    } finally {
      db.close()
    }
  })

  it('keeps canonical worktree receipts synchronized with creation progress', () => {
    const db = new Database(':memory:')
    try {
      ensureLegacyOwnerTables(db)
      ensureWorktreeCreationSchema(db)
      const store = new SqliteWorktreeCreationStore(db)
      const input = reservationInput(request())
      store.reserve(input)
      const linked = store.commitConversationOwner(conversationCommitInput())
      if (linked.kind !== 'committed') throw new Error('fixture did not link')

      const setupReceiptJson = JSON.stringify({
        requestedPolicy: 'run',
        resolvedPolicy: 'run',
        status: 'succeeded',
      })
      const startupReceiptJson = JSON.stringify({
        status: 'succeeded',
        terminalIds: ['terminal-1'],
      })
      const progressed = store.updateProgress({
        machineId: input.machineId,
        creationId: input.creationId,
        expectedRevision: linked.record.revision,
        phase: 'ready',
        status: 'ready',
        setupReceiptJson,
        startupReceiptJson,
        now: 3_000,
      })

      expect(progressed.kind).toBe('updated')
      expect(db.prepare(`
        SELECT setup_receipt_json, startup_receipt_json, updated_at
          FROM managed_worktrees WHERE id = 'worktree-1'
      `).get()).toEqual({
        setup_receipt_json: setupReceiptJson,
        startup_receipt_json: startupReceiptJson,
        updated_at: 3_000,
      })
    } finally {
      db.close()
    }
  })

  it('rolls back the managed row and creation advance when conversation ownership conflicts', () => {
    const db = new Database(':memory:')
    try {
      ensureLegacyOwnerTables(db)
      ensureWorktreeCreationSchema(db)
      const store = new SqliteWorktreeCreationStore(db)
      const input = reservationInput(request())
      const reserved = store.reserve(input)
      db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          worktree_path, worktree_branch, worktree_id, worktree_creation_id
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `).run(
        'conversation-1',
        '/Users/example/code/switchboard',
        'codex',
        'Existing conflicting conversation',
        10,
        10,
      )

      expect(() => store.commitConversationOwner(conversationCommitInput()))
        .toThrow(/constraint/i)

      expect(db.prepare('SELECT count(*) AS count FROM managed_worktrees').get())
        .toEqual({ count: 0 })
      expect(store.get({ machineId: input.machineId, creationId: input.creationId }))
        .toEqual(reserved.record)
      expect(db.prepare(`
        SELECT title, worktree_id, worktree_creation_id, worktree_path, worktree_branch
          FROM conversations WHERE id = 'conversation-1'
      `).get()).toEqual({
        title: 'Existing conflicting conversation',
        worktree_id: null,
        worktree_creation_id: null,
        worktree_path: null,
        worktree_branch: null,
      })
    } finally {
      db.close()
    }
  })
})
