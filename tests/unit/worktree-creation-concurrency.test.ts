import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { WorktreeCreationRequest } from '../../src/shared/worktree-creation'
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
  type WorktreeCreationServiceOptions,
} from '../../src/main/worktree-creation/worktree-creation-service'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function request(input: {
  creationId: string
  conversationId: string
  projectPath: string
  sparse?: boolean
  setupPolicy?: WorktreeCreationRequest['setup']['policy']
  launch?: boolean
}): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: input.creationId,
    repository: {
      projectPath: input.projectPath,
      machineId: 'machine-local',
    },
    checkout: {
      baseRef: 'HEAD',
      branch: { namespace: 'sb', seed: input.creationId },
      location: 'managed-in-repo',
      ...(input.sparse
        ? { sparseCheckout: { mode: 'cone', directories: ['src'] } }
        : {}),
    },
    owner: {
      kind: 'conversation',
      conversationId: input.conversationId,
      agentType: 'claude-code',
      title: input.creationId,
    },
    purpose: 'new-chat',
    setup: { policy: input.setupPolicy ?? 'skip' },
    ...(input.launch ? { launch: { initialAgent: { provider: 'claude-code' as const } } } : {}),
    provenance: {
      surface: 'desktop',
      machineId: 'machine-local',
      requestedAt: 1_787_523_600_000,
    },
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
  `)
}

class RecordingStore extends SqliteWorktreeCreationStore {
  private readonly reservations = new Map<string, Deferred<void>>()

  constructor(
    db: Database.Database,
    private readonly events: string[],
  ) {
    super(db)
  }

  override reserve(
    input: Parameters<SqliteWorktreeCreationStore['reserve']>[0],
  ): ReturnType<SqliteWorktreeCreationStore['reserve']> {
    const result = super.reserve(input)
    this.events.push(`reserve:${input.creationId}`)
    this.reservation(input.creationId).resolve()
    return result
  }

  override commitConversationOwner(
    input: Parameters<SqliteWorktreeCreationStore['commitConversationOwner']>[0],
  ): ReturnType<SqliteWorktreeCreationStore['commitConversationOwner']> {
    this.events.push(`link:${input.creationId}`)
    return super.commitConversationOwner(input)
  }

  whenReserved(creationId: string): Promise<void> {
    return this.reservation(creationId).promise
  }

  private reservation(creationId: string): Deferred<void> {
    let signal = this.reservations.get(creationId)
    if (!signal) {
      signal = deferred<void>()
      this.reservations.set(creationId, signal)
    }
    return signal
  }
}

class DeferredGitPort implements GitWorktreePort {
  private readonly materializeSignals = new Map<string, Deferred<void>>()
  private readonly configureSignals = new Map<string, Deferred<void>>()
  private readonly materializeGates = new Map<string, Deferred<void>>()
  private readonly configureGates = new Map<string, Deferred<void>>()

  constructor(readonly events: string[]) {}

  blockMaterialize(creationId: string): () => void {
    const gate = deferred<void>()
    this.materializeGates.set(creationId, gate)
    return () => gate.resolve()
  }

  blockConfigure(creationId: string): () => void {
    const gate = deferred<void>()
    this.configureGates.set(creationId, gate)
    return () => gate.resolve()
  }

  whenMaterializeStarts(creationId: string): Promise<void> {
    return this.materializeSignal(creationId).promise
  }

  whenConfigureStarts(creationId: string): Promise<void> {
    return this.configureSignal(creationId).promise
  }

  async resolveRepository(projectPath: string): Promise<ResolvedGitRepository> {
    this.events.push(`resolve:${projectPath}`)
    if (projectPath === '/repo/main' || projectPath === '/repo/linked') {
      return {
        repositoryId: '/repo/.git',
        commonGitDir: '/repo/.git',
        projectPath: '/repo/main',
      }
    }
    return {
      repositoryId: `${projectPath}/.git`,
      commonGitDir: `${projectPath}/.git`,
      projectPath,
    }
  }

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    this.events.push(`plan:${intent.creationId}`)
    return {
      repository: intent.repository,
      creationId: intent.creationId,
      requestedBaseRef: intent.baseRef,
      resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
      branch: `sb/${intent.creationId}`,
      worktreePath: `${intent.repository.projectPath}/.switchboard/worktrees/${intent.creationId}`,
      managedRoot: `${intent.repository.projectPath}/.switchboard/worktrees`,
      containmentRoot: intent.repository.projectPath,
    }
  }

  async materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult> {
    this.events.push(`materialize:start:${plan.creationId}`)
    this.materializeSignal(plan.creationId).resolve()
    const gate = this.materializeGates.get(plan.creationId)
    if (gate) await gate.promise
    this.events.push(`materialize:end:${plan.creationId}`)
    return {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
  }

  async inspectMaterialization(_plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    return { kind: 'absent' }
  }

  async configureSparse(
    plan: WorktreeMaterializationPlan,
    directories: string[],
  ): Promise<{ mode: 'cone'; directories: string[]; status: 'configured' }> {
    this.events.push(`configure:start:${plan.creationId}`)
    this.configureSignal(plan.creationId).resolve()
    const gate = this.configureGates.get(plan.creationId)
    if (gate) await gate.promise
    this.events.push(`configure:end:${plan.creationId}`)
    return { mode: 'cone', directories, status: 'configured' }
  }

  async rollbackMaterialization(_plan: WorktreeMaterializationPlan): Promise<WorktreeRollbackResult> {
    return { kind: 'removed' }
  }

  private materializeSignal(creationId: string): Deferred<void> {
    let signal = this.materializeSignals.get(creationId)
    if (!signal) {
      signal = deferred<void>()
      this.materializeSignals.set(creationId, signal)
    }
    return signal
  }

  private configureSignal(creationId: string): Deferred<void> {
    let signal = this.configureSignals.get(creationId)
    if (!signal) {
      signal = deferred<void>()
      this.configureSignals.set(creationId, signal)
    }
    return signal
  }
}

class DurableProgressSink implements WorktreeCreationProgressSink {
  constructor(private readonly store: SqliteWorktreeCreationStore) {}

  publish(event: Parameters<WorktreeCreationProgressSink['publish']>[0]): void {
    expect(this.store.get({
      machineId: 'machine-local',
      creationId: event.creationId,
    })).toMatchObject({
      revision: event.revision,
      phase: event.phase,
      status: event.status,
    })
  }
}

function fixture(overrides: Partial<WorktreeCreationServiceOptions> = {}) {
  const db = new Database(':memory:')
  ensureOwnerTables(db)
  ensureWorktreeCreationSchema(db)
  const events: string[] = []
  const store = new RecordingStore(db, events)
  const git = new DeferredGitPort(events)
  let now = 1_000
  let nextWorktreeId = 1
  const service = new WorktreeCreationService({
    store,
    git,
    progressSink: new DurableProgressSink(store),
    now: () => now++,
    createWorktreeId: () => `worktree-${nextWorktreeId++}`,
    ...overrides,
  })
  return { db, events, store, git, service, close: () => db.close() }
}

async function startsBeforeRelease(started: Promise<void>, timeoutMs = 100): Promise<boolean> {
  return Promise.race([
    started.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

describe('WorktreeCreationService repository concurrency', () => {
  it('serializes materialize, configure, and link for distinct creations in one repository', async () => {
    const harness = fixture()
    const first = request({
      creationId: 'creation-first',
      conversationId: 'conversation-first',
      projectPath: '/repo/main',
      sparse: true,
    })
    const second = request({
      creationId: 'creation-second',
      conversationId: 'conversation-second',
      projectPath: '/repo/main',
      sparse: true,
    })
    const releaseFirstMaterialize = harness.git.blockMaterialize(first.creationId)
    const releaseFirstConfigure = harness.git.blockConfigure(first.creationId)
    try {
      const firstResult = harness.service.createWorktreeTransaction(first)
      await harness.git.whenMaterializeStarts(first.creationId)

      const secondResult = harness.service.createWorktreeTransaction(second)
      await harness.store.whenReserved(second.creationId)
      const secondStartedDuringFirstMaterialize = harness.events.includes(
        `materialize:start:${second.creationId}`,
      )

      releaseFirstMaterialize()
      await harness.git.whenConfigureStarts(first.creationId)
      const secondStartedDuringFirstConfigure = harness.events.includes(
        `materialize:start:${second.creationId}`,
      )

      releaseFirstConfigure()
      const results = await Promise.all([firstResult, secondResult])

      expect(secondStartedDuringFirstMaterialize).toBe(false)
      expect(secondStartedDuringFirstConfigure).toBe(false)
      expect(harness.events.indexOf(`link:${first.creationId}`)).toBeLessThan(
        harness.events.indexOf(`materialize:start:${second.creationId}`),
      )
      expect(results.map((result) => result.status)).toEqual(['ready', 'ready'])
    } finally {
      releaseFirstMaterialize()
      releaseFirstConfigure()
      harness.close()
    }
  })

  it('allows worktree mutations in distinct canonical repositories to overlap', async () => {
    const harness = fixture()
    const first = request({
      creationId: 'creation-repo-one',
      conversationId: 'conversation-repo-one',
      projectPath: '/repo-one',
    })
    const second = request({
      creationId: 'creation-repo-two',
      conversationId: 'conversation-repo-two',
      projectPath: '/repo-two',
    })
    const releaseFirst = harness.git.blockMaterialize(first.creationId)
    try {
      const firstResult = harness.service.createWorktreeTransaction(first)
      await harness.git.whenMaterializeStarts(first.creationId)

      const secondResult = harness.service.createWorktreeTransaction(second)
      const overlapped = await startsBeforeRelease(
        harness.git.whenMaterializeStarts(second.creationId),
      )
      releaseFirst()
      const results = await Promise.all([firstResult, secondResult])

      expect(overlapped).toBe(true)
      expect(results.map((result) => result.status)).toEqual(['ready', 'ready'])
    } finally {
      releaseFirst()
      harness.close()
    }
  })

  it('releases repository mutation serialization before setup execution finishes', async () => {
    const setupStarted = deferred<void>()
    const setupFinished = deferred<{ kind: 'succeeded'; exitCode: number }>()
    const harness = fixture({
      setupConfig: {
        load: async () => ({
          command: './setup-worktree',
          defaultPolicy: 'run',
          startupPolicy: 'wait-for-setup',
        }),
      },
      setupRunner: {
        run: async () => {
          setupStarted.resolve()
          return setupFinished.promise
        },
      },
    })
    const first = request({
      creationId: 'creation-with-long-setup',
      conversationId: 'conversation-with-long-setup',
      projectPath: '/repo/main',
      setupPolicy: 'run',
    })
    const second = request({
      creationId: 'creation-after-long-setup',
      conversationId: 'conversation-after-long-setup',
      projectPath: '/repo/main',
    })
    try {
      const firstResult = harness.service.createWorktreeTransaction(first)
      await setupStarted.promise

      const secondResult = harness.service.createWorktreeTransaction(second)
      const secondStartedBeforeSetupFinished = await startsBeforeRelease(
        harness.git.whenMaterializeStarts(second.creationId),
      )

      setupFinished.resolve({ kind: 'succeeded', exitCode: 0 })
      const results = await Promise.all([firstResult, secondResult])

      expect(secondStartedBeforeSetupFinished).toBe(true)
      expect(results.map((result) => result.status)).toEqual(['ready', 'ready'])
    } finally {
      setupFinished.resolve({ kind: 'succeeded', exitCode: 0 })
      harness.close()
    }
  })

  it('releases repository mutation serialization before startup execution finishes', async () => {
    const startupStarted = deferred<void>()
    const startupFinished = deferred<{
      status: 'succeeded'
      terminalIds: string[]
      providerThreadId: string
    }>()
    const harness = fixture({
      startupLauncher: {
        launch: async () => {
          startupStarted.resolve()
          return startupFinished.promise
        },
      },
    })
    const first = request({
      creationId: 'creation-with-long-startup',
      conversationId: 'conversation-with-long-startup',
      projectPath: '/repo/main',
      launch: true,
    })
    const second = request({
      creationId: 'creation-after-long-startup',
      conversationId: 'conversation-after-long-startup',
      projectPath: '/repo/main',
    })
    try {
      const firstResult = harness.service.createWorktreeTransaction(first)
      await startupStarted.promise

      const secondResult = harness.service.createWorktreeTransaction(second)
      const secondStartedBeforeStartupFinished = await startsBeforeRelease(
        harness.git.whenMaterializeStarts(second.creationId),
      )

      startupFinished.resolve({
        status: 'succeeded',
        terminalIds: [],
        providerThreadId: 'conversation-with-long-startup',
      })
      const results = await Promise.all([firstResult, secondResult])

      expect(secondStartedBeforeStartupFinished).toBe(true)
      expect(results.map((result) => result.status)).toEqual(['ready', 'ready'])
    } finally {
      startupFinished.resolve({
        status: 'succeeded',
        terminalIds: [],
        providerThreadId: 'conversation-with-long-startup',
      })
      harness.close()
    }
  })

  it('serializes main and linked-checkout aliases that resolve to one repositoryId', async () => {
    const harness = fixture()
    const fromMain = request({
      creationId: 'creation-main-alias',
      conversationId: 'conversation-main-alias',
      projectPath: '/repo/main',
    })
    const fromLinked = request({
      creationId: 'creation-linked-alias',
      conversationId: 'conversation-linked-alias',
      projectPath: '/repo/linked',
    })
    const releaseMain = harness.git.blockMaterialize(fromMain.creationId)
    try {
      const mainResult = harness.service.createWorktreeTransaction(fromMain)
      await harness.git.whenMaterializeStarts(fromMain.creationId)

      const linkedResult = harness.service.createWorktreeTransaction(fromLinked)
      await harness.store.whenReserved(fromLinked.creationId)
      const aliasMutatedConcurrently = harness.events.includes(
        `materialize:start:${fromLinked.creationId}`,
      )
      releaseMain()
      await Promise.all([mainResult, linkedResult])

      expect(aliasMutatedConcurrently).toBe(false)
      expect(harness.events.indexOf(`link:${fromMain.creationId}`)).toBeLessThan(
        harness.events.indexOf(`materialize:start:${fromLinked.creationId}`),
      )
    } finally {
      releaseMain()
      harness.close()
    }
  })

  it('validates, plans, and durably reserves a waiter before repository mutation is available', async () => {
    const harness = fixture()
    const first = request({
      creationId: 'creation-lock-holder',
      conversationId: 'conversation-lock-holder',
      projectPath: '/repo/main',
    })
    const waiter = request({
      creationId: 'creation-lock-waiter',
      conversationId: 'conversation-lock-waiter',
      projectPath: '/repo/linked',
    })
    const releaseFirst = harness.git.blockMaterialize(first.creationId)
    try {
      const firstResult = harness.service.createWorktreeTransaction(first)
      await harness.git.whenMaterializeStarts(first.creationId)

      const waiterResult = harness.service.createWorktreeTransaction(waiter)
      await harness.store.whenReserved(waiter.creationId)
      const durableWaiter = harness.store.get({
        machineId: 'machine-local',
        creationId: waiter.creationId,
      })
      const mutatedWhileWaiting = harness.events.includes(`materialize:start:${waiter.creationId}`)

      releaseFirst()
      await Promise.all([firstResult, waiterResult])

      expect(harness.events).toContain(`resolve:${waiter.repository.projectPath}`)
      expect(harness.events).toContain(`plan:${waiter.creationId}`)
      expect(durableWaiter).toMatchObject({
        creationId: waiter.creationId,
        reservedPath: '/repo/main/.switchboard/worktrees/creation-lock-waiter',
        reservedBranch: 'sb/creation-lock-waiter',
        requestedBaseRef: 'HEAD',
        resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
        status: 'pending',
      })
      expect(mutatedWhileWaiting).toBe(false)
    } finally {
      releaseFirst()
      harness.close()
    }
  })
})
