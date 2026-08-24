import { createHash } from 'node:crypto'
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
import { withBackendRequestContext } from '../../src/main/backend/request-context'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1A',
    repository: {
      projectPath: '/repo',
      machineId: 'machine-local',
    },
    checkout: {
      baseRef: 'HEAD',
      branch: { namespace: 'sb', seed: 'Transactional worktree' },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-1',
      agentType: 'claude-code',
      title: 'Transactional worktree',
    },
    purpose: 'new-chat',
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
      worktree_path TEXT,
      worktree_branch TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class ScriptedGitWorktreePort implements GitWorktreePort {
  readonly calls: string[] = []
  readonly rollbackModes: Array<'compensate' | 'explicit_remove' | undefined> = []
  readonly repository: ResolvedGitRepository = {
    repositoryId: '/repo/.git',
    commonGitDir: '/repo/.git',
    projectPath: '/repo',
  }
  readonly materializationStarted = deferred<void>()
  beforeMaterialize: (() => void) | null = null
  materializationBlock: Promise<void> | null = null
  configureFailure: Error | null = null
  rollbackFailure: Error | null = null
  rollbackResult: WorktreeRollbackResult = { kind: 'removed' }

  async resolveRepository(projectPath: string): Promise<ResolvedGitRepository> {
    this.calls.push('resolveRepository')
    expect(projectPath).toBe('/repo')
    return this.repository
  }

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    this.calls.push('planMaterialization')
    return {
      repository: intent.repository,
      creationId: intent.creationId,
      requestedBaseRef: intent.baseRef,
      resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
      branch: 'sb/transactional-worktree-ddb6658ef4',
      worktreePath: '/repo/.switchboard/worktrees/transactional-worktree-ddb6658ef4',
      managedRoot: '/repo/.switchboard/worktrees',
      containmentRoot: '/repo',
    }
  }

  async materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult> {
    this.calls.push('materialize')
    this.beforeMaterialize?.()
    this.materializationStarted.resolve()
    if (this.materializationBlock) await this.materializationBlock
    return {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
  }

  async inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    this.calls.push('inspectMaterialization')
    return {
      kind: 'exact',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
  }

  async configureSparse(
    _plan: WorktreeMaterializationPlan,
    directories: string[],
  ): Promise<{ mode: 'cone'; directories: string[]; status: 'configured' }> {
    this.calls.push('configureSparse')
    if (this.configureFailure) throw this.configureFailure
    return { mode: 'cone', directories: [...new Set(directories)].sort(), status: 'configured' }
  }

  async rollbackMaterialization(
    _plan: WorktreeMaterializationPlan,
    mode?: 'compensate' | 'explicit_remove',
  ): Promise<WorktreeRollbackResult> {
    this.calls.push('rollbackMaterialization')
    this.rollbackModes.push(mode)
    if (this.rollbackFailure) throw this.rollbackFailure
    return this.rollbackResult
  }
}

class RecordingProgressSink implements WorktreeCreationProgressSink {
  readonly events: WorktreeCreationProgressEvent[] = []

  constructor(private readonly store: SqliteWorktreeCreationStore) {}

  publish(event: WorktreeCreationProgressEvent): void {
    const durable = this.store.get({
      machineId: 'machine-local',
      creationId: event.creationId,
    })
    expect(durable?.revision).toBe(event.revision)
    expect(durable?.phase).toBe(event.phase)
    expect(durable?.status).toBe(event.status)
    this.events.push(event)
  }
}

function fixture(overrides: Record<string, unknown> = {}) {
  const db = new Database(':memory:')
  ensureOwnerTables(db)
  ensureWorktreeCreationSchema(db)
  const store = new SqliteWorktreeCreationStore(db)
  const git = new ScriptedGitWorktreePort()
  const progressSink = new RecordingProgressSink(store)
  let now = 1_000
  const service = new WorktreeCreationService({
    store,
    git,
    progressSink,
    now: () => now++,
    createWorktreeId: () => 'worktree-1',
    ...overrides,
  })
  return {
    db,
    store,
    git,
    progressSink,
    service,
    close: () => db.close(),
  }
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('WorktreeCreationService', () => {
  it('rejects an invalid request before reserving storage or calling Git', async () => {
    const harness = fixture()
    try {
      const invalid = {
        ...request(),
        repository: { projectPath: 'relative/repo', machineId: 'machine-local' },
      } as WorktreeCreationRequest

      await expect(harness.service.createWorktreeTransaction(invalid))
        .rejects.toThrow(/project path must be absolute/i)

      expect(count(harness.db, 'worktree_creations')).toBe(0)
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(harness.git.calls).toEqual([])
      expect(harness.progressSink.events).toEqual([])
    } finally {
      harness.close()
    }
  })

  it('persists pending intent before materializing and returns one ready no-launch conversation', async () => {
    const harness = fixture()
    try {
      harness.git.beforeMaterialize = () => {
        expect(harness.store.get({
          machineId: 'machine-local',
          creationId: request().creationId,
        })).toMatchObject({
          phase: 'materializing',
          status: 'pending',
        })
      }

      const snapshot = await harness.service.createWorktreeTransaction(request())

      expect(harness.git.calls.indexOf('resolveRepository')).toBeLessThan(
        harness.git.calls.indexOf('planMaterialization'),
      )
      expect(harness.git.calls.indexOf('planMaterialization')).toBeLessThan(
        harness.git.calls.indexOf('materialize'),
      )
      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(1)
      expect(snapshot).toMatchObject({
        creationId: request().creationId,
        phase: 'ready',
        status: 'ready',
        worktreeId: 'worktree-1',
        projectPath: '/repo',
        worktreePath: '/repo/.switchboard/worktrees/transactional-worktree-ddb6658ef4',
        branch: 'sb/transactional-worktree-ddb6658ef4',
      })
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
      expect(harness.db.prepare(`
        SELECT project_path, worktree_id, worktree_creation_id,
               worktree_path, worktree_branch
          FROM conversations WHERE id = 'conversation-1'
      `).get()).toEqual({
        project_path: '/repo',
        worktree_id: 'worktree-1',
        worktree_creation_id: request().creationId,
        worktree_path: '/repo/.switchboard/worktrees/transactional-worktree-ddb6658ef4',
        worktree_branch: 'sb/transactional-worktree-ddb6658ef4',
      })
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ phase: 'ready', status: 'ready', worktreeId: 'worktree-1' })
      expect(harness.progressSink.events.at(-1)).toMatchObject({ phase: 'ready', status: 'ready' })
    } finally {
      harness.close()
    }
  })

  it('returns the canonical ready snapshot for a duplicate without materializing twice', async () => {
    const harness = fixture()
    try {
      const first = await harness.service.createWorktreeTransaction(request())
      const duplicate = await harness.service.createWorktreeTransaction(request())

      expect(duplicate).toEqual(first)
      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('refuses destructive worktree removal from a chat-only remote credential', async () => {
    const harness = fixture()
    try {
      const ready = await harness.service.createWorktreeTransaction(request())

      await expect(withBackendRequestContext(
        { clientScope: 'phone:one', transport: 'remote', deviceScopes: ['chat'] },
        () => harness.service.actOnWorktreeCreation({
          machineId: 'machine-local',
          creationId: ready.creationId,
          expectedRevision: ready.revision,
          action: 'remove',
        }),
      )).rejects.toThrow(/remov.*terminal.*scope/i)

      expect(harness.git.rollbackModes).toEqual([])
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: ready.creationId,
      })).toMatchObject({ phase: 'ready', status: 'ready' })
    } finally {
      harness.close()
    }
  })

  it('keeps the same origin idempotent across scope normalization and persists the first authority', async () => {
    const launchCalls: unknown[] = []
    const harness = fixture({
      startupLauncher: {
        launch: async (input: unknown) => {
          launchCalls.push(input)
          return { status: 'succeeded' as const, terminalIds: [], providerThreadId: 'conversation-1' }
        },
      },
    })
    const original = request({ launch: { initialAgent: { provider: 'claude-code' } } })
    try {
      const first = await withBackendRequestContext(
        { clientScope: 'phone:one', transport: 'remote', deviceScopes: ['chat'] },
        () => harness.service.createWorktreeTransaction(original),
      )
      const duplicate = await withBackendRequestContext(
        { clientScope: 'desktop:remote', transport: 'remote', deviceScopes: ['chat', 'terminal'] },
        () => harness.service.createWorktreeTransaction(original),
      )

      expect(duplicate).toEqual(first)
      expect(launchCalls).toHaveLength(1)
      expect(JSON.parse(harness.store.get({
        machineId: 'machine-local',
        creationId: original.creationId,
      })!.requestJson)).toMatchObject({ launch: { terminalPolicy: 'skip' } })
    } finally {
      harness.close()
    }
  })

  it('returns a hard conflict for the same creation identity with changed owner payload', async () => {
    const harness = fixture()
    try {
      await harness.service.createWorktreeTransaction(request())
      const changed = request({
        owner: {
          kind: 'conversation',
          conversationId: 'conversation-1',
          agentType: 'claude-code',
          title: 'Changed payload',
        },
      })

      await expect(harness.service.createWorktreeTransaction(changed))
        .rejects.toMatchObject({ name: 'WorktreeCreationConflictError' })

      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('single-flights concurrent identical creation calls through one materialization', async () => {
    const harness = fixture()
    const releaseMaterialization = deferred<void>()
    harness.git.materializationBlock = releaseMaterialization.promise
    try {
      const first = harness.service.createWorktreeTransaction(request())
      await harness.git.materializationStarted.promise
      const concurrent = harness.service.createWorktreeTransaction(request())
      releaseMaterialization.resolve()

      const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent])

      expect(concurrentSnapshot).toEqual(firstSnapshot)
      expect(firstSnapshot).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(harness.git.calls.filter((call) => call === 'resolveRepository')).toHaveLength(1)
      expect(harness.git.calls.filter((call) => call === 'planMaterialization')).toHaveLength(1)
      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      releaseMaterialization.resolve()
      harness.close()
    }
  })

  it('returns the durable resolved cone sparse-checkout receipt', async () => {
    const harness = fixture()
    try {
      const base = request()
      const result = await harness.service.createWorktreeTransaction(request({
        checkout: {
          ...base.checkout,
          sparseCheckout: {
            mode: 'cone',
            directories: ['packages/app', 'src'],
            presetId: 'app-only',
          },
        },
      }))

      expect(harness.git.calls.indexOf('configureSparse')).toBeLessThan(harness.git.calls.indexOf('rollbackMaterialization') === -1
        ? Number.MAX_SAFE_INTEGER
        : harness.git.calls.indexOf('rollbackMaterialization'))
      expect(result.sparseCheckoutReceipt).toEqual({
        mode: 'cone',
        directories: ['packages/app', 'src'],
        presetId: 'app-only',
        status: 'configured',
      })
    } finally {
      harness.close()
    }
  })

  it('preserves the triggering failure after successful compensation', async () => {
    const harness = fixture()
    harness.git.configureFailure = new Error('sparse checkout rejected directory src')
    try {
      const base = request()
      const result = await harness.service.createWorktreeTransaction(request({
        checkout: {
          ...base.checkout,
          sparseCheckout: { mode: 'cone', directories: ['src'] },
        },
      }))

      expect(result).toMatchObject({
        status: 'rolled_back',
        error: {
          code: 'creation_compensated',
          message: expect.stringContaining('sparse checkout rejected directory src'),
        },
      })
    } finally {
      harness.close()
    }
  })

  it('preserves both the triggering and rollback failures when compensation needs cleanup', async () => {
    const harness = fixture()
    harness.git.configureFailure = new Error('sparse checkout rejected directory src')
    harness.git.rollbackFailure = new Error('git worktree remove failed')
    try {
      const base = request()
      const result = await harness.service.createWorktreeTransaction(request({
        checkout: {
          ...base.checkout,
          sparseCheckout: { mode: 'cone', directories: ['src'] },
        },
      }))

      expect(result).toMatchObject({
        status: 'cleanup_required',
        error: {
          code: 'rollback_failed',
          message: expect.stringContaining('sparse checkout rejected directory src'),
        },
      })
      expect(result.error?.message).toContain('git worktree remove failed')
    } finally {
      harness.close()
    }
  })

  it('runs an explicitly configured setup only after durable owner linkage and persists its receipt', async () => {
    const setupCalls: Array<{ cwd: string; command: string; ownerCommitted: boolean }> = []
    let harness!: ReturnType<typeof fixture>
    harness = fixture({
      setupConfig: {
        load: async () => ({
          command: 'npm ci',
          defaultPolicy: 'ask',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: {
        run: async ({ cwd, command }: { cwd: string; command: string }) => {
          setupCalls.push({
            cwd,
            command,
            ownerCommitted: harness.store.isConversationOwnerCommitted({
              machineId: 'machine-local',
              creationId: request().creationId,
            }),
          })
          return { kind: 'succeeded', exitCode: 0 }
        },
      },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'run' },
      }))

      expect(setupCalls).toEqual([{
        cwd: '/repo/.switchboard/worktrees/transactional-worktree-ddb6658ef4',
        command: 'npm ci',
        ownerCommitted: true,
      }])
      expect(result).toMatchObject({
        phase: 'ready',
        status: 'ready',
        setupReceipt: {
          requestedPolicy: 'run',
          resolvedPolicy: 'run',
          status: 'succeeded',
          commandSource: 'launch-config',
          exitCode: 0,
        },
      })
      expect(JSON.parse(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })!.setupReceiptJson!)).toMatchObject({ status: 'succeeded', exitCode: 0 })
    } finally {
      harness.close()
    }
  })

  it('starts workspace provisioning without waiting for setup when repository policy says start-immediately', async () => {
    const setupStarted = deferred<void>()
    const releaseSetup = deferred<{ kind: 'succeeded'; exitCode: number }>()
    const startupCalls: unknown[] = []
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'start-immediately',
        }),
      },
      setupRunner: {
        run: async () => {
          setupStarted.resolve()
          return releaseSetup.promise
        },
      },
      startupLauncher: {
        launch: async (input: unknown) => {
          startupCalls.push(input)
          return {
            status: 'succeeded' as const,
            terminalIds: ['terminal-concurrent-1'],
            providerThreadId: 'conversation-1',
          }
        },
      },
    })
    const launchedRequest = request({
      setup: { policy: 'inherit' },
      launch: { initialAgent: { provider: 'claude-code' } },
    })
    let creation: Promise<unknown> | undefined
    try {
      creation = harness.service.createWorktreeTransaction(launchedRequest)
      await setupStarted.promise
      await Promise.resolve()

      expect(startupCalls).toHaveLength(1)

      releaseSetup.resolve({ kind: 'succeeded', exitCode: 0 })
      await expect(creation).resolves.toMatchObject({
        phase: 'ready',
        status: 'ready',
        setupReceipt: { status: 'succeeded' },
        startupReceipt: {
          status: 'succeeded',
          terminalIds: ['terminal-concurrent-1'],
        },
      })
    } finally {
      releaseSetup.resolve({ kind: 'succeeded', exitCode: 0 })
      await creation?.catch(() => undefined)
      harness.close()
    }
  })

  it('returns not_configured without guessing a package-manager command', async () => {
    const runCalls: unknown[] = []
    const harness = fixture({
      setupConfig: { load: async () => undefined },
      setupRunner: { run: async (input: unknown) => { runCalls.push(input); return { kind: 'succeeded' } } },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'run' },
      }))

      expect(result).toMatchObject({
        status: 'ready',
        setupReceipt: {
          requestedPolicy: 'run',
          resolvedPolicy: 'run',
          status: 'not_configured',
        },
      })
      expect(runCalls).toEqual([])
    } finally {
      harness.close()
    }
  })

  it('retains a worktree when setup fails after the external mutation boundary', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: { run: async () => ({ kind: 'failed', exitCode: 12 }) },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'inherit' },
      }))

      expect(result).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        setupReceipt: { status: 'failed', exitCode: 12 },
      })
      expect(result.recoveryActions).toEqual(['retain', 'remove'])
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('immediately records a throwing setup port as ambiguous cleanup instead of leaving a running operation', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: { run: async () => { throw new Error('setup transport closed') } },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({ setup: { policy: 'run' } }))

      expect(result).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        setupReceipt: { status: 'ambiguous' },
        error: { code: 'setup_outcome_unknown', retryable: false },
      })
      expect(result.recoveryActions).toEqual(['retain'])
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ phase: 'provisioning', status: 'cleanup_required' })
    } finally {
      harness.close()
    }
  })

  it('durably pauses an inherited ask policy and resumes the same creation after an explicit skip', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: 'npm ci',
          defaultPolicy: 'ask',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: { run: async () => { throw new Error('must not run') } },
    })
    try {
      const paused = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'inherit' },
      }))

      expect(paused).toMatchObject({
        phase: 'awaiting_setup_decision',
        status: 'pending',
        setupReceipt: { status: 'awaiting_decision' },
      })
      expect(paused.recoveryActions).toEqual(['choose_setup_run', 'choose_setup_skip'])

      const ready = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: paused.revision,
        action: 'choose_setup_skip',
      })
      expect(ready).toMatchObject({
        phase: 'ready',
        status: 'ready',
        setupReceipt: { status: 'skipped' },
      })
      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(1)
    } finally {
      harness.close()
    }
  })

  it('requires a fresh setup decision when the configured command changes after approval was requested', async () => {
    let command = 'npm ci'
    const setupCalls: string[] = []
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command,
          defaultPolicy: 'ask' as const,
          startupPolicy: 'wait-for-setup' as const,
        }),
      },
      setupRunner: {
        run: async (input: { command: string }) => {
          setupCalls.push(input.command)
          return { kind: 'succeeded' as const, exitCode: 0 }
        },
      },
    })
    try {
      const paused = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'inherit' },
      }))
      expect(paused.setupReceipt).toMatchObject({
        status: 'awaiting_decision',
        commandFingerprint: createHash('sha256').update('npm ci').digest('hex'),
      })

      command = 'npm install'
      const refreshed = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: paused.revision,
        action: 'choose_setup_run',
      })

      expect(refreshed).toMatchObject({
        phase: 'awaiting_setup_decision',
        status: 'pending',
        setupReceipt: {
          status: 'awaiting_decision',
          commandFingerprint: createHash('sha256').update('npm install').digest('hex'),
        },
        recoveryActions: ['choose_setup_run', 'choose_setup_skip'],
      })
      expect(refreshed.revision).toBeGreaterThan(paused.revision)
      expect(setupCalls).toEqual([])

      const ready = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: refreshed.revision,
        action: 'choose_setup_run',
      })
      expect(ready).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(setupCalls).toEqual(['npm install'])
    } finally {
      harness.close()
    }
  })

  it('refuses a chat-only remote setup choice using the canonical persisted request', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'ask',
          startupPolicy: 'wait-for-setup',
        }),
      },
    })
    try {
      const paused = await harness.service.createWorktreeTransaction(request({ setup: { policy: 'inherit' } }))

      await expect(withBackendRequestContext(
        { clientScope: 'phone:one', transport: 'remote', deviceScopes: ['chat'] },
        () => harness.service.actOnWorktreeCreation({
          machineId: 'machine-local',
          creationId: request().creationId,
          expectedRevision: paused.revision,
          action: 'choose_setup_run',
        }),
      )).rejects.toThrow(/setup.*terminal.*scope/i)
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ phase: 'awaiting_setup_decision', status: 'pending' })
    } finally {
      harness.close()
    }
  })

  it('starts the selected provider in the durable worktree and enqueues the initial prompt exactly once', async () => {
    const launchCalls: unknown[] = []
    let harness!: ReturnType<typeof fixture>
    harness = fixture({
      setupConfig: { load: async () => undefined },
      startupLauncher: {
        launch: async (input: unknown) => {
          launchCalls.push({
            input,
            ownerCommitted: harness.store.isConversationOwnerCommitted({
              machineId: 'machine-local',
              creationId: request().creationId,
            }),
          })
          return {
            status: 'succeeded',
            terminalIds: [],
            providerThreadId: 'conversation-1',
            initialPromptOrigin: `${request().creationId}:initial-prompt`,
          }
        },
      },
    })
    const launchedRequest = request({
      setup: { policy: 'skip' },
      launch: {
        initialAgent: {
          provider: 'claude-code',
          instanceId: 'claude-work',
          runtimeMode: 'plan',
          prompt: 'Begin from the durable worktree.',
        },
      },
    })
    try {
      const first = await harness.service.createWorktreeTransaction(launchedRequest)
      const duplicate = await harness.service.createWorktreeTransaction(launchedRequest)

      expect(first).toMatchObject({
        phase: 'ready',
        status: 'ready',
        startupReceipt: {
          status: 'succeeded',
          providerThreadId: 'conversation-1',
          initialPromptOrigin: `${request().creationId}:initial-prompt`,
        },
      })
      expect(duplicate).toEqual(first)
      expect(launchCalls).toHaveLength(1)
      expect(launchCalls[0]).toMatchObject({
        ownerCommitted: true,
        input: {
          creationId: request().creationId,
          projectPath: '/repo',
          worktreePath: '/repo/.switchboard/worktrees/transactional-worktree-ddb6658ef4',
          branch: 'sb/transactional-worktree-ddb6658ef4',
          conversationId: 'conversation-1',
          initialPromptOrigin: `${request().creationId}:initial-prompt`,
          launch: launchedRequest.launch,
        },
      })
    } finally {
      harness.close()
    }
  })

  it('retains the durable worktree and conversation when provider startup fails', async () => {
    const harness = fixture({
      startupLauncher: {
        launch: async () => ({ status: 'failed', terminalIds: [] }),
      },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({
        launch: { initialAgent: { provider: 'claude-code' } },
      }))

      expect(result).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        startupReceipt: { status: 'failed' },
      })
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('fails closed before startup when the durable worktree path or branch is missing', async () => {
    let launchCount = 0
    let harness!: ReturnType<typeof fixture>
    harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: {
        run: async () => {
          harness.db.prepare(`
            UPDATE worktree_creations
               SET reserved_path = NULL, reserved_branch = NULL
          `).run()
          return { kind: 'succeeded' as const }
        },
      },
      startupLauncher: {
        launch: async () => {
          launchCount += 1
          return { status: 'succeeded' as const, terminalIds: [] }
        },
      },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'run' },
        launch: {
          initialAgent: { provider: 'claude-code' },
        },
      }))

      expect(launchCount).toBe(0)
      expect(result).toMatchObject({
        status: 'cleanup_required',
        error: { code: 'startup_identity_missing' },
      })
    } finally {
      harness.close()
    }
  })

  it('immediately records a throwing startup port as ambiguous and retryable', async () => {
    const harness = fixture({
      startupLauncher: {
        launch: async () => { throw new Error('startup acknowledgement lost') },
      },
    })
    const launchedRequest = request({
      launch: { initialAgent: { provider: 'claude-code', prompt: 'Start once.' } },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(launchedRequest)

      expect(result).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        startupReceipt: {
          status: 'ambiguous',
          terminalIds: [],
          initialPromptOrigin: `${launchedRequest.creationId}:initial-prompt`,
        },
        error: { code: 'startup_outcome_unknown', retryable: true },
      })
      expect(result.recoveryActions).toContain('retry')
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: launchedRequest.creationId,
      })).toMatchObject({ phase: 'provisioning', status: 'cleanup_required' })
    } finally {
      harness.close()
    }
  })

  it('settles concurrent setup and startup throws into durable ambiguous receipts', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'start-immediately',
        }),
      },
      setupRunner: { run: async () => { throw new Error('setup port threw') } },
      startupLauncher: { launch: async () => { throw new Error('startup port threw') } },
    })
    try {
      const result = await harness.service.createWorktreeTransaction(request({
        setup: { policy: 'inherit' },
        launch: { initialAgent: { provider: 'claude-code' } },
      }))

      expect(result).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        setupReceipt: { status: 'ambiguous' },
        startupReceipt: { status: 'ambiguous', terminalIds: [] },
        error: { code: 'setup_outcome_unknown', retryable: false },
      })
    } finally {
      harness.close()
    }
  })

  it('retries ambiguous startup with the same creation and initial-prompt origin', async () => {
    const launchInputs: Array<{ creationId: string; initialPromptOrigin: string }> = []
    const harness = fixture({
      startupLauncher: {
        launch: async (input: { creationId: string; initialPromptOrigin: string }) => {
          launchInputs.push(input)
          return launchInputs.length === 1
            ? {
                status: 'ambiguous' as const,
                terminalIds: [],
                providerThreadId: 'conversation-1',
                initialPromptOrigin: input.initialPromptOrigin,
              }
            : {
                status: 'succeeded' as const,
                terminalIds: ['terminal-creation-1'],
                providerThreadId: 'conversation-1',
                initialPromptOrigin: input.initialPromptOrigin,
              }
        },
      },
    })
    const launchedRequest = request({
      launch: {
        initialAgent: {
          provider: 'claude-code',
          prompt: 'Deliver once.',
        },
      },
    })
    try {
      const ambiguous = await harness.service.createWorktreeTransaction(launchedRequest)

      expect(ambiguous).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        startupReceipt: { status: 'ambiguous' },
      })
      expect(ambiguous.recoveryActions).toContain('retry')

      const reconciled = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: launchedRequest.creationId,
        expectedRevision: ambiguous.revision,
        action: 'retry',
      })

      expect(reconciled).toMatchObject({
        phase: 'ready',
        status: 'ready',
        startupReceipt: {
          status: 'succeeded',
          terminalIds: ['terminal-creation-1'],
        },
      })
      expect(reconciled.error).toBeUndefined()
      expect(launchInputs).toHaveLength(2)
      expect(launchInputs[1]).toMatchObject({
        creationId: launchedRequest.creationId,
        initialPromptOrigin: `${launchedRequest.creationId}:initial-prompt`,
      })
      expect(launchInputs[1]).toEqual(launchInputs[0])
    } finally {
      harness.close()
    }
  })

  it('refuses chat-only retry of a terminal-authorized startup but allows retry of a persisted no-terminal agent', async () => {
    let launchCount = 0
    const harness = fixture({
      startupLauncher: {
        launch: async () => {
          launchCount += 1
          return launchCount === 1
            ? { status: 'ambiguous' as const, terminalIds: [] }
            : { status: 'succeeded' as const, terminalIds: [], providerThreadId: 'conversation-1' }
        },
      },
    })
    const launched = request({ launch: { initialAgent: { provider: 'claude-code' } } })
    try {
      const ambiguous = await harness.service.createWorktreeTransaction(launched)
      await expect(withBackendRequestContext(
        { clientScope: 'phone:one', transport: 'remote', deviceScopes: ['chat'] },
        () => harness.service.actOnWorktreeCreation({
          machineId: 'machine-local',
          creationId: launched.creationId,
          expectedRevision: ambiguous.revision,
          action: 'retry',
        }),
      )).rejects.toThrow(/terminal.*scope/i)
      expect(launchCount).toBe(1)
    } finally {
      harness.close()
    }

    launchCount = 0
    const remoteHarness = fixture({
      startupLauncher: {
        launch: async () => {
          launchCount += 1
          return launchCount === 1
            ? { status: 'ambiguous' as const, terminalIds: [] }
            : { status: 'succeeded' as const, terminalIds: [], providerThreadId: 'conversation-1' }
        },
      },
    })
    try {
      const ambiguous = await withBackendRequestContext(
        { clientScope: 'phone:one', transport: 'remote', deviceScopes: ['chat'] },
        () => remoteHarness.service.createWorktreeTransaction(launched),
      )
      const ready = await withBackendRequestContext(
        { clientScope: 'phone:one', transport: 'remote', deviceScopes: ['chat'] },
        () => remoteHarness.service.actOnWorktreeCreation({
          machineId: 'machine-local',
          creationId: launched.creationId,
          expectedRevision: ambiguous.revision,
          action: 'retry',
        }),
      )
      expect(ready).toMatchObject({ status: 'ready' })
      expect(launchCount).toBe(2)
    } finally {
      remoteHarness.close()
    }
  })

  it('records an explicit retain disposition while keeping later explicit cleanup available', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: { run: async () => ({ kind: 'failed' as const, exitCode: 2 }) },
    })
    try {
      const failed = await harness.service.createWorktreeTransaction(request({ setup: { policy: 'run' } }))
      const retained = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: failed.revision,
        action: 'retain',
      })

      expect(retained).toMatchObject({
        status: 'cleanup_required',
        cleanupDisposition: 'retained',
        recoveryActions: ['remove'],
      })
      expect(harness.db.prepare(`SELECT lifecycle FROM managed_worktrees`).get())
        .toEqual({ lifecycle: 'retained' })
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
    } finally {
      harness.close()
    }
  })

  it('removes an exact clean retained worktree but preserves the conversation in the parent checkout', async () => {
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: { run: async () => ({ kind: 'failed' as const, exitCode: 2 }) },
    })
    try {
      const failed = await harness.service.createWorktreeTransaction(request({ setup: { policy: 'run' } }))
      harness.db.prepare(`INSERT INTO messages VALUES ('message-1', 'conversation-1', 'Preserve this history.')`).run()
      const removed = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: failed.revision,
        action: 'remove',
      })

      expect(removed).toMatchObject({
        status: 'rolled_back',
        cleanupDisposition: 'removed',
        recoveryActions: [],
      })
      expect(harness.git.calls.at(-1)).toBe('rollbackMaterialization')
      expect(harness.git.rollbackModes).toEqual(['explicit_remove'])
      expect(harness.db.prepare(`SELECT lifecycle FROM managed_worktrees`).get())
        .toEqual({ lifecycle: 'removed' })
      expect(count(harness.db, 'conversations')).toBe(1)
      expect(count(harness.db, 'messages')).toBe(1)
      expect(harness.db.prepare(`
        SELECT worktree_path, worktree_branch, worktree_id, worktree_creation_id
          FROM conversations
      `).get()).toEqual({
        worktree_path: null,
        worktree_branch: null,
        worktree_id: null,
        worktree_creation_id: null,
      })
    } finally {
      harness.close()
    }
  })

  it('keeps a ready worktree ready and linked when explicit removal is refused', async () => {
    const harness = fixture()
    try {
      const ready = await harness.service.createWorktreeTransaction(request())
      harness.git.rollbackResult = { kind: 'refused', reason: 'dirty' }

      const refused = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: ready.revision,
        action: 'remove',
      })

      expect(refused).toMatchObject({
        status: 'ready',
        phase: 'ready',
        cleanupDisposition: 'removal_refused',
        error: { code: 'removal_refused' },
      })
      expect(harness.db.prepare(`SELECT lifecycle FROM managed_worktrees`).get())
        .toEqual({ lifecycle: 'active' })
      expect(harness.db.prepare(`SELECT worktree_path FROM conversations`).get())
        .toEqual({ worktree_path: refused.worktreePath })
    } finally {
      harness.close()
    }
  })
})
