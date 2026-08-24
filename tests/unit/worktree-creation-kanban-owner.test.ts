import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type {
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
} from '../../src/shared/worktree-creation'
import {
  ensureWorktreeCreationSchema,
  SqliteWorktreeCreationStore,
} from '../../src/main/db/worktree-creation'
import type {
  ResolvedGitRepository,
  WorktreeMaterializationInspection,
  WorktreeMaterializationIntent,
  WorktreeMaterializationPlan,
  WorktreeMaterializationResult,
  WorktreeRollbackResult,
} from '../../src/main/worktree-creation/git-adapter'
import {
  WorktreeCreationService,
  type GitWorktreePort,
  type WorktreeCreationProgressSink,
} from '../../src/main/worktree-creation/worktree-creation-service'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const WORKTREE_PATH = '/repo/.switchboard/worktrees/card-worktree-1234567890'
const WORKTREE_BRANCH = 'kanban/card-worktree-1234567890'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'creation-kanban-owner',
    repository: {
      projectPath: '/repo',
      machineId: 'machine-local',
    },
    checkout: {
      baseRef: 'HEAD',
      branch: { namespace: 'kanban', seed: 'Card worktree' },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'kanban-card',
      cardId: 'card-kanban-owner',
      create: {
        title: 'Implement owner transaction',
        description: 'Keep this draft even when Git fails.',
        tags: ['worktree', 'backend'],
        status: 'backlog',
        runtimeMode: 'plan',
        costCapUsd: 12.5,
      },
    },
    purpose: 'kanban',
    setup: { policy: 'skip' },
    provenance: {
      surface: 'desktop',
      machineId: 'machine-local',
      requestedAt: 1_787_523_600_000,
    },
    ...overrides,
  }
}

function ensureOwnerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      worktree_path TEXT,
      worktree_branch TEXT
    );

    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'backlog',
      cost_cap_usd REAL,
      cost_used_usd REAL,
      runtime_mode TEXT NOT NULL DEFAULT 'accept-edits',
      conversation_id TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `)
}

class ScriptedGitPort implements GitWorktreePort {
  readonly calls: string[] = []
  materializeResults: WorktreeMaterializationResult[] = []
  rollbackResult: WorktreeRollbackResult = { kind: 'removed' }

  async resolveRepository(projectPath: string): Promise<ResolvedGitRepository> {
    this.calls.push('resolveRepository')
    return {
      repositoryId: '/repo/.git',
      commonGitDir: '/repo/.git',
      projectPath,
    }
  }

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    this.calls.push('planMaterialization')
    return {
      repository: intent.repository,
      creationId: intent.creationId,
      requestedBaseRef: intent.baseRef,
      resolvedBaseCommit: COMMIT,
      branch: WORKTREE_BRANCH,
      worktreePath: WORKTREE_PATH,
      managedRoot: '/repo/.switchboard/worktrees',
      containmentRoot: '/repo',
    }
  }

  async materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult> {
    this.calls.push('materialize')
    return this.materializeResults.shift() ?? {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
  }

  async inspectMaterialization(_plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    this.calls.push('inspectMaterialization')
    return { kind: 'absent' }
  }

  async configureSparse(
    _plan: WorktreeMaterializationPlan,
    directories: string[],
  ): Promise<{ mode: 'cone'; directories: string[]; status: 'configured' }> {
    this.calls.push('configureSparse')
    return { mode: 'cone', directories, status: 'configured' }
  }

  async rollbackMaterialization(_plan: WorktreeMaterializationPlan): Promise<WorktreeRollbackResult> {
    this.calls.push('rollbackMaterialization')
    return this.rollbackResult
  }
}

interface AtomicLinkObservation {
  cardWorktreeId: string | null
  cardCreationId: string | null
  managedWorktrees: number
}

class DurableProgressSink implements WorktreeCreationProgressSink {
  readonly events: WorktreeCreationProgressEvent[] = []
  readonly atomicLinks: AtomicLinkObservation[] = []

  constructor(
    private readonly db: Database.Database,
    private readonly store: SqliteWorktreeCreationStore,
  ) {}

  publish(event: WorktreeCreationProgressEvent): void {
    expect(this.store.get({
      machineId: 'machine-local',
      creationId: event.creationId,
    })).toMatchObject({
      revision: event.revision,
      phase: event.phase,
      status: event.status,
    })
    if (event.phase === 'linking' && event.status === 'pending') {
      const card = this.db.prepare(`
        SELECT worktree_id, worktree_creation_id
          FROM kanban_cards
         WHERE id = 'card-kanban-owner'
      `).get() as { worktree_id: string | null; worktree_creation_id: string | null } | undefined
      this.atomicLinks.push({
        cardWorktreeId: card?.worktree_id ?? null,
        cardCreationId: card?.worktree_creation_id ?? null,
        managedWorktrees: count(this.db, 'managed_worktrees'),
      })
    }
    this.events.push(event)
  }
}

function fixture(options: {
  startupLauncher?: ConstructorParameters<typeof WorktreeCreationService>[0]['startupLauncher']
} = {}) {
  const db = new Database(':memory:')
  ensureOwnerTables(db)
  ensureWorktreeCreationSchema(db)
  const store = new SqliteWorktreeCreationStore(db)
  const git = new ScriptedGitPort()
  const progressSink = new DurableProgressSink(db, store)
  let now = 1_000
  const service = new WorktreeCreationService({
    store,
    git,
    progressSink,
    now: () => now++,
    createWorktreeId: () => 'worktree-kanban-owner',
    startupLauncher: options.startupLauncher,
  })
  return { db, store, git, progressSink, service, close: () => db.close() }
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}

function card(db: Database.Database) {
  return db.prepare(`
    SELECT id, project_path, title, description, tags, status, runtime_mode, cost_cap_usd,
           conversation_id, worktree_path, worktree_branch, worktree_id,
           worktree_creation_id, created_at, updated_at
      FROM kanban_cards
     WHERE id = 'card-kanban-owner'
  `).get() as {
    id: string
    project_path: string
    title: string
    description: string
    tags: string
    status: string
    runtime_mode: string
    cost_cap_usd: number | null
    conversation_id: string | null
    worktree_path: string | null
    worktree_branch: string | null
    worktree_id: string | null
    worktree_creation_id: string | null
    created_at: number
    updated_at: number
  } | undefined
}

function insertExistingCard(db: Database.Database, updatedAt = 700): void {
  db.prepare(`
    INSERT INTO kanban_cards (
      id, project_path, title, description, tags, status, runtime_mode,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'card-kanban-owner',
    '/repo',
    'Existing card',
    'Existing description',
    JSON.stringify(['existing']),
    'backlog',
    'accept-edits',
    600,
    updatedAt,
  )
}

describe('WorktreeCreationService Kanban owner', () => {
  it('atomically creates a card, canonical worktree, and compatibility projections', async () => {
    const harness = fixture()
    try {
      const result = await harness.service.createWorktreeTransaction(request())

      expect(result).toMatchObject({
        phase: 'ready',
        status: 'ready',
        worktreeId: 'worktree-kanban-owner',
        worktreePath: WORKTREE_PATH,
        branch: WORKTREE_BRANCH,
      })
      expect(card(harness.db)).toMatchObject({
        id: 'card-kanban-owner',
        project_path: '/repo',
        title: 'Implement owner transaction',
        description: 'Keep this draft even when Git fails.',
        tags: JSON.stringify(['worktree', 'backend']),
        status: 'backlog',
        runtime_mode: 'plan',
        cost_cap_usd: 12.5,
        conversation_id: null,
        worktree_path: WORKTREE_PATH,
        worktree_branch: WORKTREE_BRANCH,
        worktree_id: 'worktree-kanban-owner',
        worktree_creation_id: request().creationId,
      })
      expect(harness.progressSink.atomicLinks).toContainEqual({
        cardWorktreeId: 'worktree-kanban-owner',
        cardCreationId: request().creationId,
        managedWorktrees: 1,
      })
      expect(count(harness.db, 'kanban_cards')).toBe(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(0)
      expect(harness.db.prepare(`
        SELECT initial_owner_kind, initial_owner_id, purpose
          FROM managed_worktrees
      `).get()).toEqual({
        initial_owner_kind: 'kanban-card',
        initial_owner_id: 'card-kanban-owner',
        purpose: 'kanban',
      })
    } finally {
      harness.close()
    }
  })

  it('attaches an existing card only when its expected revision still matches', async () => {
    const harness = fixture()
    try {
      insertExistingCard(harness.db, 700)
      const attach = request({
        owner: {
          kind: 'kanban-card',
          cardId: 'card-kanban-owner',
          expectedRevision: 700,
        },
      })

      const result = await harness.service.createWorktreeTransaction(attach)

      expect(result).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(card(harness.db)).toMatchObject({
        title: 'Existing card',
        description: 'Existing description',
        tags: JSON.stringify(['existing']),
        worktree_path: WORKTREE_PATH,
        worktree_branch: WORKTREE_BRANCH,
        worktree_id: 'worktree-kanban-owner',
        worktree_creation_id: attach.creationId,
      })
      expect(count(harness.db, 'kanban_cards')).toBe(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('rejects a stale existing-card precondition before Git and leaves the card untouched', async () => {
    const harness = fixture()
    try {
      insertExistingCard(harness.db, 700)
      const staleAttach = request({
        owner: {
          kind: 'kanban-card',
          cardId: 'card-kanban-owner',
          expectedRevision: 699,
        },
      })

      await expect(harness.service.createWorktreeTransaction(staleAttach))
        .rejects.toMatchObject({ name: 'WorktreeCreationOwnerConflictError' })

      expect(harness.git.calls).toEqual([])
      expect(card(harness.db)).toMatchObject({
        updated_at: 700,
        worktree_path: null,
        worktree_branch: null,
        worktree_id: null,
        worktree_creation_id: null,
      })
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'worktree_creations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('rejects attaching a worktree to a card that already owns a live conversation', async () => {
    const harness = fixture()
    try {
      insertExistingCard(harness.db, 700)
      harness.db.prepare(`
        INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at)
        VALUES ('existing-chat', '/repo', 'claude-code', 'Existing chat', 600, 700)
      `).run()
      harness.db.prepare(`UPDATE kanban_cards SET conversation_id = 'existing-chat' WHERE id = 'card-kanban-owner'`).run()

      await expect(harness.service.createWorktreeTransaction(request({
        owner: {
          kind: 'kanban-card',
          cardId: 'card-kanban-owner',
          expectedRevision: 700,
        },
      }))).rejects.toThrow(/already has a conversation/i)

      expect(harness.git.calls).toEqual([])
      expect(card(harness.db)).toMatchObject({
        conversation_id: 'existing-chat',
        worktree_id: null,
        worktree_creation_id: null,
      })
      expect(count(harness.db, 'conversations')).toBe(1)
      expect(count(harness.db, 'worktree_creations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('preserves a new backlog card linked to a failed creation without false worktree projections', async () => {
    const harness = fixture()
    try {
      harness.git.materializeResults = [{
        kind: 'conflict',
        worktreePath: WORKTREE_PATH,
        branch: WORKTREE_BRANCH,
        reason: 'branch_exists',
      }]

      const failed = await harness.service.createWorktreeTransaction(request())

      expect(failed).toMatchObject({ phase: 'materializing', status: 'failed' })
      expect(failed.recoveryActions).toContain('retry')
      expect(card(harness.db)).toMatchObject({
        id: 'card-kanban-owner',
        title: 'Implement owner transaction',
        description: 'Keep this draft even when Git fails.',
        status: 'backlog',
        worktree_path: null,
        worktree_branch: null,
        worktree_id: null,
        worktree_creation_id: request().creationId,
      })
      expect(count(harness.db, 'kanban_cards')).toBe(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('rolls back Git when the atomic card-link write fails without duplicating the preserved card', async () => {
    const harness = fixture()
    try {
      harness.db.exec(`
        CREATE TRIGGER reject_kanban_worktree_link
        BEFORE UPDATE OF worktree_id ON kanban_cards
        WHEN NEW.worktree_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'simulated kanban owner link conflict');
        END;
      `)

      const rolledBack = await harness.service.createWorktreeTransaction(request())

      expect(rolledBack).toMatchObject({ phase: 'linking', status: 'rolled_back' })
      expect(harness.git.calls.at(-1)).toBe('rollbackMaterialization')
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'kanban_cards')).toBe(1)
      expect(card(harness.db)).toMatchObject({
        worktree_path: null,
        worktree_branch: null,
        worktree_id: null,
        worktree_creation_id: request().creationId,
      })
    } finally {
      harness.close()
    }
  })

  it('retries the same failed creation onto the same preserved card', async () => {
    const harness = fixture()
    try {
      harness.git.materializeResults = [{
        kind: 'conflict',
        worktreePath: WORKTREE_PATH,
        branch: WORKTREE_BRANCH,
        reason: 'branch_exists',
      }]
      const failed = await harness.service.createWorktreeTransaction(request())
      const cardBeforeRetry = card(harness.db)

      const ready = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: failed.revision,
        action: 'retry',
      })

      expect(ready).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(count(harness.db, 'kanban_cards')).toBe(1)
      expect(card(harness.db)).toMatchObject({
        id: cardBeforeRetry?.id,
        created_at: cardBeforeRetry?.created_at,
        title: cardBeforeRetry?.title,
        description: cardBeforeRetry?.description,
        worktree_id: 'worktree-kanban-owner',
        worktree_creation_id: request().creationId,
      })
      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(2)
    } finally {
      harness.close()
    }
  })

  it('atomically links a stable conversation before launching the initial agent exactly once', async () => {
    const launchCalls: Array<Parameters<NonNullable<ConstructorParameters<typeof WorktreeCreationService>[0]['startupLauncher']>['launch']>[0]> = []
    const harness = fixture({
      startupLauncher: {
        launch: async (input) => {
          const linked = card(harness.db)
          expect(linked?.conversation_id).toBe(input.conversationId)
          expect(linked?.status).toBe('in_progress')
          expect(count(harness.db, 'conversations')).toBe(1)
          expect(harness.db.prepare(`
            SELECT worktree_id, worktree_creation_id, worktree_path, worktree_branch, sidebar_role
              FROM conversations WHERE id = ?
          `).get(input.conversationId)).toEqual({
            worktree_id: 'worktree-kanban-owner',
            worktree_creation_id: request().creationId,
            worktree_path: WORKTREE_PATH,
            worktree_branch: WORKTREE_BRANCH,
            sidebar_role: 'managed',
          })
          launchCalls.push(input)
          return {
            status: 'succeeded',
            terminalIds: ['kanban-terminal'],
            providerThreadId: input.conversationId,
            initialPromptOrigin: input.initialPromptOrigin,
          }
        },
      },
    })
    try {
      const launch = {
        launchConfigName: 'Development',
        initialAgent: {
          provider: 'claude-code' as const,
          runtimeMode: 'plan' as const,
          prompt: 'Implement the card.',
        },
      }
      const launchedRequest = request({
        owner: {
          kind: 'kanban-card',
          cardId: 'card-kanban-owner',
          create: {
            title: 'Implement owner transaction',
            description: 'Keep this draft even when Git fails.',
            tags: ['worktree', 'backend'],
            status: 'backlog',
            runtimeMode: 'plan',
            costCapUsd: 12.5,
          },
        },
        launch,
      })
      const readyLaunch = await harness.service.createWorktreeTransaction(launchedRequest)
      const journal = harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })
      const storedRequest = JSON.parse(journal?.requestJson ?? '{}') as WorktreeCreationRequest

      expect(readyLaunch).toMatchObject({
        phase: 'ready',
        status: 'ready',
        startupReceipt: {
          status: 'succeeded',
          terminalIds: ['kanban-terminal'],
        },
      })
      expect(storedRequest.launch).toEqual({ ...launch, terminalPolicy: 'provision' })
      expect(card(harness.db)).toMatchObject({
        status: 'in_progress',
        conversation_id: readyLaunch.startupReceipt?.providerThreadId,
        worktree_id: 'worktree-kanban-owner',
        worktree_creation_id: request().creationId,
      })
      expect(Object.keys(card(harness.db) ?? {})).not.toEqual(
        expect.arrayContaining(['provider', 'runtimeMode', 'prompt']),
      )

      await harness.service.createWorktreeTransaction(launchedRequest)
      await harness.service.recoverInterruptedCreations()
      expect(await harness.service.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(launchCalls).toHaveLength(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })
})
