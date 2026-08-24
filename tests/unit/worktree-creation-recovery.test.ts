import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeWorktreeCreationIdentity,
  canonicalizeWorktreeCreationRequest,
  type WorktreeCreationProgressEvent,
  type WorktreeCreationRequest,
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
  createWorktreeCreationService,
  startWorktreeCreationService,
  type GitWorktreePort,
  type WorktreeCreationProgressSink,
  type WorktreeCreationServiceOptions,
} from '../../src/main/worktree-creation/worktree-creation-service'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const RESOLVED_BASE_COMMIT = '0123456789abcdef0123456789abcdef01234567'
const WORKTREE_PATH = '/repo/.switchboard/worktrees/recovery-test-4f18c2f3aa'
const WORKTREE_BRANCH = 'sb/recovery-test-4f18c2f3aa'

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
      branch: { namespace: 'sb', seed: 'Recovery test' },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-recovery',
      agentType: 'claude-code',
      title: 'Recovery test',
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
  `)
}

type GitState =
  | { kind: 'absent' }
  | { kind: 'exact'; plan: WorktreeMaterializationPlan }
  | { kind: 'branch_only'; plan: WorktreeMaterializationPlan }
  | {
      kind: 'mismatch'
      plan: WorktreeMaterializationPlan
      reason: 'path_mismatch' | 'branch_mismatch'
    }

interface GitWorld {
  state: GitState
  totalMaterializations: number
}

type MaterializeScript =
  | 'completed'
  | 'outcome_unknown_exact'
  | 'outcome_unknown_absent'
  | 'outcome_unknown_branch_only'
  | 'outcome_unknown_mismatch'

class RecoveryGitPort implements GitWorktreePort {
  readonly calls: string[] = []
  readonly inspectedPlans: WorktreeMaterializationPlan[] = []
  readonly materializedPlans: WorktreeMaterializationPlan[] = []
  rollbackCalls = 0
  private readonly repository: ResolvedGitRepository = {
    repositoryId: '/repo/.git',
    commonGitDir: '/repo/.git',
    projectPath: '/repo',
  }

  constructor(
    private readonly world: GitWorld,
    private readonly script: MaterializeScript = 'completed',
  ) {}

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
      resolvedBaseCommit: RESOLVED_BASE_COMMIT,
      branch: WORKTREE_BRANCH,
      worktreePath: WORKTREE_PATH,
      managedRoot: '/repo/.switchboard/worktrees',
      containmentRoot: '/repo',
    }
  }

  async materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult> {
    this.calls.push('materialize')
    this.materializedPlans.push(plan)
    this.world.totalMaterializations += 1

    if (this.script === 'outcome_unknown_absent' && this.world.totalMaterializations === 1) {
      this.world.state = { kind: 'absent' }
      return {
        kind: 'outcome_unknown',
        worktreePath: plan.worktreePath,
        branch: plan.branch,
        reason: 'transport ended before Git reported a result',
      }
    }
    if (this.script === 'outcome_unknown_branch_only' && this.world.totalMaterializations === 1) {
      this.world.state = { kind: 'branch_only', plan }
      return {
        kind: 'outcome_unknown',
        worktreePath: plan.worktreePath,
        branch: plan.branch,
        reason: 'transport ended after branch creation',
      }
    }
    if (this.script === 'outcome_unknown_mismatch') {
      this.world.state = { kind: 'mismatch', plan, reason: 'path_mismatch' }
      return {
        kind: 'outcome_unknown',
        worktreePath: plan.worktreePath,
        branch: plan.branch,
        reason: 'transport ended after an unexpected checkout appeared',
      }
    }

    this.world.state = { kind: 'exact', plan }
    if (this.script === 'outcome_unknown_exact') {
      return {
        kind: 'outcome_unknown',
        worktreePath: plan.worktreePath,
        branch: plan.branch,
        reason: 'response lost after git worktree add returned',
      }
    }
    return {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
  }

  async inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    this.calls.push('inspectMaterialization')
    this.inspectedPlans.push(plan)
    if (this.world.state.kind === 'absent') return { kind: 'absent' }
    if (this.world.state.kind === 'branch_only') {
      return {
        kind: 'branch_only',
        branch: this.world.state.plan.branch,
        headCommit: this.world.state.plan.resolvedBaseCommit,
      }
    }
    if (this.world.state.kind === 'mismatch') {
      return {
        kind: 'mismatch',
        reason: this.world.state.reason,
        observed: {
          worktreePath: this.world.state.plan.worktreePath,
          branch: this.world.state.plan.branch,
          headCommit: 'ffffffffffffffffffffffffffffffffffffffff',
        },
      }
    }
    return {
      kind: 'exact',
      worktreePath: this.world.state.plan.worktreePath,
      branch: this.world.state.plan.branch,
      headCommit: this.world.state.plan.resolvedBaseCommit,
    }
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
    this.rollbackCalls += 1
    this.world.state = { kind: 'absent' }
    return { kind: 'removed' }
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
    expect(durable).toMatchObject({
      revision: event.revision,
      phase: event.phase,
      status: event.status,
    })
    this.events.push(event)
  }
}

function fixture() {
  const db = new Database(':memory:')
  ensureOwnerTables(db)
  ensureWorktreeCreationSchema(db)
  const store = new SqliteWorktreeCreationStore(db)
  const progressSink = new RecordingProgressSink(store)
  let now = 1_000
  const options = (git: GitWorktreePort): WorktreeCreationServiceOptions => ({
    store,
    git,
    progressSink,
    now: () => now++,
    createWorktreeId: () => 'worktree-recovery-1',
  })
  return {
    db,
    store,
    progressSink,
    options,
    close: () => db.close(),
  }
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}

function expectPersistedPlan(store: SqliteWorktreeCreationStore): void {
  expect(store.get({
    machineId: 'machine-local',
    creationId: request().creationId,
  })).toMatchObject({
    reservedPath: WORKTREE_PATH,
    reservedBranch: WORKTREE_BRANCH,
    requestedBaseRef: 'HEAD',
    resolvedBaseCommit: RESOLVED_BASE_COMMIT,
  })
}

function expectRecoveredPlan(plan: WorktreeMaterializationPlan): void {
  expect(plan).toEqual({
    repository: {
      repositoryId: '/repo/.git',
      commonGitDir: '/repo/.git',
      projectPath: '/repo',
    },
    creationId: request().creationId,
    requestedBaseRef: 'HEAD',
    resolvedBaseCommit: RESOLVED_BASE_COMMIT,
    branch: WORKTREE_BRANCH,
    worktreePath: WORKTREE_PATH,
    managedRoot: '/repo/.switchboard/worktrees',
    containmentRoot: '/repo',
  })
}

function reservePending(store: SqliteWorktreeCreationStore) {
  const value = request()
  const payloadHash = createHash('sha256')
    .update(canonicalizeWorktreeCreationIdentity(value))
    .digest('hex')
  return store.reserve({
    machineId: value.repository.machineId,
    creationId: value.creationId,
    schemaVersion: value.schemaVersion,
    requestJson: canonicalizeWorktreeCreationRequest(value),
    payloadHash,
    reservedPath: WORKTREE_PATH,
    reservedBranch: WORKTREE_BRANCH,
    requestedBaseRef: value.checkout.baseRef,
    resolvedBaseCommit: RESOLVED_BASE_COMMIT,
    now: 900,
  })
}

describe('worktree creation restart recovery', () => {
  it('finalizes a recorded rollback after a crash instead of rematerializing the removed worktree', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    const value = request()
    const plan: WorktreeMaterializationPlan = {
      repository: {
        repositoryId: '/repo/.git',
        commonGitDir: '/repo/.git',
        projectPath: '/repo',
      },
      creationId: value.creationId,
      requestedBaseRef: 'HEAD',
      resolvedBaseCommit: RESOLVED_BASE_COMMIT,
      branch: WORKTREE_BRANCH,
      worktreePath: WORKTREE_PATH,
      managedRoot: '/repo/.switchboard/worktrees',
      containmentRoot: '/repo',
    }
    try {
      harness.store.reserve({
        machineId: value.repository.machineId,
        creationId: value.creationId,
        schemaVersion: value.schemaVersion,
        requestJson: canonicalizeWorktreeCreationRequest(value),
        payloadHash: createHash('sha256')
          .update(canonicalizeWorktreeCreationIdentity(value))
          .digest('hex'),
        reservedPath: WORKTREE_PATH,
        reservedBranch: WORKTREE_BRANCH,
        requestedBaseRef: 'HEAD',
        resolvedBaseCommit: RESOLVED_BASE_COMMIT,
        materializationPlanJson: JSON.stringify(plan),
        now: 900,
      })
      harness.db.prepare(`
        UPDATE worktree_creations
           SET phase = 'linking', status = 'pending', external_boundary = 'rollback_started'
         WHERE machine_id = 'machine-local' AND creation_id = ?
      `).run(value.creationId)

      const git = new RecoveryGitPort(world)
      const restarted = await createWorktreeCreationService(harness.options(git))
      const recovered = await restarted.getWorktreeCreation({
        machineId: value.repository.machineId,
        creationId: value.creationId,
      })

      expect(recovered).toMatchObject({ phase: 'linking', status: 'rolled_back' })
      expect(world.totalMaterializations).toBe(0)
      expect(git.calls).not.toContain('materialize')
    } finally {
      harness.close()
    }
  })

  it('starts recovery in the background and single-flights a same-id retry while setup is blocked', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    const originalSetupEntered = deferred<void>()
    const originalSetupBlocked = deferred<{
      command: string
      defaultPolicy: 'run'
      startupPolicy: 'wait-for-setup'
    }>()
    const restartSetupEntered = deferred<void>()
    const restartSetupConfig = deferred<{
      command: string
      defaultPolicy: 'run'
      startupPolicy: 'wait-for-setup'
    }>()
    let restartConfigLoads = 0
    let restartSetupRuns = 0
    try {
      const first = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        setupConfig: {
          load: async () => {
            originalSetupEntered.resolve()
            return originalSetupBlocked.promise
          },
        },
      })
      void first.createWorktreeTransaction(request({ setup: { policy: 'run' } }))
      await originalSetupEntered.promise

      const restarted = startWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        setupConfig: {
          load: async () => {
            restartConfigLoads += 1
            restartSetupEntered.resolve()
            return restartSetupConfig.promise
          },
        },
        setupRunner: {
          run: async () => {
            restartSetupRuns += 1
            return { kind: 'succeeded' as const, exitCode: 0 }
          },
        },
      })

      await expect(restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).resolves.toMatchObject({ phase: 'linking', status: 'pending' })
      await restartSetupEntered.promise

      const sameIdRetry = restarted.createWorktreeTransaction(request({ setup: { policy: 'run' } }))
      await Promise.resolve()
      expect(restartConfigLoads).toBe(1)

      restartSetupConfig.resolve({
        command: './setup-worktree',
        defaultPolicy: 'run',
        startupPolicy: 'wait-for-setup',
      })
      await expect(sameIdRetry).resolves.toMatchObject({ phase: 'ready', status: 'ready' })
      expect(restartConfigLoads).toBe(1)
      expect(restartSetupRuns).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('keeps an owner-linked setup decision paused without re-linking or deleting its worktree', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const first = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        setupConfig: {
          load: async () => ({ defaultPolicy: 'ask', startupPolicy: 'wait-for-setup' }),
        },
      })
      const paused = await first.createWorktreeTransaction(request({ setup: { policy: 'inherit' } }))
      expect(paused).toMatchObject({ phase: 'awaiting_setup_decision', status: 'pending' })

      const restartGit = new RecoveryGitPort(world)
      const restarted = await createWorktreeCreationService({
        ...harness.options(restartGit),
        setupConfig: {
          load: async () => ({ defaultPolicy: 'ask', startupPolicy: 'wait-for-setup' }),
        },
      })
      const recovered = await restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })

      expect(recovered).toMatchObject({ phase: 'awaiting_setup_decision', status: 'pending' })
      expect(recovered.recoveryActions).toEqual(['choose_setup_run', 'choose_setup_skip'])
      expect(restartGit.calls).toEqual([])
      expect(restartGit.rollbackCalls).toBe(0)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it.each(['succeeded', 'skipped', 'not_configured'] as const)(
    'finishes a setup-only creation after restart when its %s receipt was durable',
    async (receiptStatus) => {
      const harness = fixture()
      const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
      try {
        const first = await createWorktreeCreationService(harness.options(new RecoveryGitPort(world)))
        const ready = await first.createWorktreeTransaction(request())
        const interrupted = harness.store.updateProgress({
          machineId: 'machine-local',
          creationId: request().creationId,
          expectedRevision: ready.revision,
          phase: 'provisioning',
          status: 'pending',
          setupReceiptJson: JSON.stringify({
            requestedPolicy: 'skip',
            resolvedPolicy: 'skip',
            status: receiptStatus,
          }),
          now: 950,
        })
        expect(interrupted.kind).toBe('updated')

        const restartGit = new RecoveryGitPort(world)
        const restarted = await createWorktreeCreationService(harness.options(restartGit))
        const recovered = await restarted.getWorktreeCreation({
          machineId: 'machine-local',
          creationId: request().creationId,
        })
        expect(recovered).toMatchObject({ phase: 'ready', status: 'ready' })
        expect(restartGit.calls).toEqual([])
      } finally {
        harness.close()
      }
    },
  )

  it('isolates a malformed setup config after owner commit and keeps the service available', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const first = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        setupConfig: {
          load: async () => ({ defaultPolicy: 'skip', startupPolicy: 'wait-for-setup' }),
        },
      })
      const ready = await first.createWorktreeTransaction(request({ setup: { policy: 'inherit' } }))
      const linking = harness.store.updateProgress({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: ready.revision,
        phase: 'linking',
        status: 'pending',
        now: 960,
      })
      expect(linking.kind).toBe('updated')

      const restarted = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        setupConfig: { load: async () => { throw new Error('invalid launch config') } },
      })
      const recovered = await restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })
      expect(recovered).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        error: { code: 'setup_config_invalid' },
      })
    } finally {
      harness.close()
    }
  })

  it('reconciles an exact worktree before returning an outcome-unknown response', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const firstGit = new RecoveryGitPort(world, 'outcome_unknown_exact')
      const firstService = await createWorktreeCreationService(harness.options(firstGit))

      const ready = await firstService.createWorktreeTransaction(request())

      expect(ready).toMatchObject({
        phase: 'ready',
        status: 'ready',
        worktreeId: 'worktree-recovery-1',
      })
      expectPersistedPlan(harness.store)
      expect(firstGit.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(1)
      expectRecoveredPlan(firstGit.inspectedPlans[0])
      expect(world.totalMaterializations).toBe(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
      expect(firstGit.rollbackCalls).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('reconciles an outcome-unknown materialization when the same request is retried', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const git = new RecoveryGitPort(world, 'outcome_unknown_exact')
      const service = await createWorktreeCreationService(harness.options(git))
      const first = await service.createWorktreeTransaction(request())
      expect(first).toMatchObject({ phase: 'ready', status: 'ready' })

      const reconciled = await service.createWorktreeTransaction(request())
      expect(reconciled).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(world.totalMaterializations).toBe(1)
      expect(git.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(1)
    } finally {
      harness.close()
    }
  })

  it('returns an actionable failure when an unknown materialization is absent', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const firstGit = new RecoveryGitPort(world, 'outcome_unknown_absent')
      const firstService = await createWorktreeCreationService(harness.options(firstGit))
      const failed = await firstService.createWorktreeTransaction(request())

      expect(failed).toMatchObject({ phase: 'materializing', status: 'failed' })
      expect(failed.recoveryActions).toContain('retry')
      expectPersistedPlan(harness.store)

      const recovered = await firstService.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: failed.revision,
        action: 'retry',
      })

      expect(recovered).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(firstGit.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(1)
      expect(firstGit.calls.filter((call) => call === 'materialize')).toHaveLength(2)
      expectRecoveredPlan(firstGit.inspectedPlans[0])
      expectRecoveredPlan(firstGit.materializedPlans[1])
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('rolls back a branch-only unknown materialization and permits an exact retry', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const git = new RecoveryGitPort(world, 'outcome_unknown_branch_only')
      const service = await createWorktreeCreationService(harness.options(git))

      const rolledBack = await service.createWorktreeTransaction(request())

      expect(rolledBack).toMatchObject({ phase: 'materializing', status: 'rolled_back' })
      expect(rolledBack.recoveryActions).toContain('retry')
      expect(git.rollbackCalls).toBe(1)
      expect(world.state).toEqual({ kind: 'absent' })

      const ready = await service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: rolledBack.revision,
        action: 'retry',
      })
      expect(ready).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(world.totalMaterializations).toBe(2)
    } finally {
      harness.close()
    }
  })

  it('marks a mismatched checkout cleanup-required without rollback or deletion', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const firstGit = new RecoveryGitPort(world, 'outcome_unknown_mismatch')
      const firstService = await createWorktreeCreationService(harness.options(firstGit))
      await firstService.createWorktreeTransaction(request())

      const restartGit = new RecoveryGitPort(world)
      const restarted = await createWorktreeCreationService(harness.options(restartGit))
      const recovered = await restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })

      expect(recovered).toMatchObject({
        phase: 'materializing',
        status: 'cleanup_required',
      })
      expect(recovered.recoveryActions).toEqual(expect.arrayContaining(['retain', 'remove']))
      expect(firstGit.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(1)
      expect(restartGit.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(0)
      expect(restartGit.calls).not.toContain('materialize')
      expect(firstGit.rollbackCalls + restartGit.rollbackCalls).toBe(0)
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('returns the canonical ready result after the original response is lost', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const firstGit = new RecoveryGitPort(world)
      const firstService = await createWorktreeCreationService(harness.options(firstGit))
      const committedBeforeResponseLoss = await firstService.createWorktreeTransaction(request())

      const restartGit = new RecoveryGitPort(world)
      const restarted = await createWorktreeCreationService(harness.options(restartGit))
      const canonical = await restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })

      expect(canonical).toEqual(committedBeforeResponseLoss)
      expect(canonical).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(world.totalMaterializations).toBe(1)
      expect(restartGit.calls).not.toContain('materialize')
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('rejects a stale action without mutation, then safely cancels a pending reservation', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const git = new RecoveryGitPort(world)
      const service = await createWorktreeCreationService(harness.options(git))
      const reservation = reservePending(harness.store)
      expect(reservation.kind).toBe('reserved')

      await expect(service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: 0,
        action: 'cancel',
      })).rejects.toMatchObject({ name: 'WorktreeCreationRevisionConflictError' })

      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ revision: 1, phase: 'pending', status: 'pending' })
      expect(git.calls).toEqual([])

      const cancelled = await service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: 1,
        action: 'cancel',
      })

      expect(cancelled).toMatchObject({ revision: 2, phase: 'pending', status: 'cancelled' })
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
      expect(git.calls).toEqual([])
    } finally {
      harness.close()
    }
  })

  it('does not treat cancellation as safe after materialization has begun', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    try {
      const git = new RecoveryGitPort(world)
      const service = await createWorktreeCreationService(harness.options(git))
      const reservation = reservePending(harness.store)
      expect(reservation.kind).toBe('reserved')
      const materializing = harness.store.transition({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: 1,
        phase: 'materializing',
        status: 'pending',
        now: 901,
      })
      expect(materializing.kind).toBe('updated')

      await expect(service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: 2,
        action: 'cancel',
      })).rejects.toMatchObject({ name: 'WorktreeCreationUnsafeActionError' })

      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ revision: 2, phase: 'materializing', status: 'pending' })
      expect(git.calls).toEqual([])
      expect(git.rollbackCalls).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('marks an interrupted running setup ambiguous without executing it again', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    const setupEntered = deferred<void>()
    const neverFinishes = deferred<{ kind: 'succeeded'; exitCode: number }>()
    let restartSetupCalls = 0
    try {
      const firstGit = new RecoveryGitPort(world)
      const firstService = await createWorktreeCreationService({
        ...harness.options(firstGit),
        setupConfig: {
          load: async () => ({
            command: './setup-worktree',
            defaultPolicy: 'run',
            startupPolicy: 'wait-for-setup',
          }),
        },
        setupRunner: {
          run: async () => {
            setupEntered.resolve()
            return neverFinishes.promise
          },
        },
      })

      void firstService.createWorktreeTransaction(request({ setup: { policy: 'run' } }))
      await setupEntered.promise

      const restarted = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        setupConfig: {
          load: async () => ({
            command: './setup-worktree',
            defaultPolicy: 'run',
            startupPolicy: 'wait-for-setup',
          }),
        },
        setupRunner: {
          run: async () => {
            restartSetupCalls += 1
            return { kind: 'succeeded' as const, exitCode: 0 }
          },
        },
      })

      const recovered = await restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })
      expect(recovered).toMatchObject({
        phase: 'provisioning',
        status: 'cleanup_required',
        setupReceipt: { status: 'ambiguous' },
        error: { code: 'setup_interrupted', retryable: false },
      })
      expect(restartSetupCalls).toBe(0)
      expect(recovered.recoveryActions).toEqual(['retain'])
    } finally {
      harness.close()
    }
  })

  it('reconciles interrupted startup with the same creation and prompt origin', async () => {
    const harness = fixture()
    const world: GitWorld = { state: { kind: 'absent' }, totalMaterializations: 0 }
    const startupEntered = deferred<void>()
    const neverFinishes = deferred<{
      status: 'succeeded'
      terminalIds: string[]
      providerThreadId: string
      initialPromptOrigin: string
    }>()
    const restartInputs: unknown[] = []
    const launched = request({
      launch: {
        initialAgent: {
          provider: 'claude-code',
          runtimeMode: 'plan',
          prompt: 'Resume exactly once.',
        },
      },
    })
    try {
      const firstService = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        startupLauncher: {
          launch: async () => {
            startupEntered.resolve()
            return neverFinishes.promise
          },
        },
      })

      void firstService.createWorktreeTransaction(launched)
      await startupEntered.promise

      const restarted = await createWorktreeCreationService({
        ...harness.options(new RecoveryGitPort(world)),
        startupLauncher: {
          launch: async (input) => {
            restartInputs.push(input)
            return {
              status: 'succeeded' as const,
              terminalIds: ['terminal-stable-1'],
              providerThreadId: 'conversation-recovery',
              initialPromptOrigin: `${request().creationId}:initial-prompt`,
            }
          },
        },
      })

      const recovered = await restarted.getWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
      })
      expect(recovered).toMatchObject({
        phase: 'ready',
        status: 'ready',
        startupReceipt: {
          status: 'succeeded',
          terminalIds: ['terminal-stable-1'],
          initialPromptOrigin: `${request().creationId}:initial-prompt`,
        },
      })
      expect(restartInputs).toHaveLength(1)
      expect(restartInputs[0]).toMatchObject({
        creationId: request().creationId,
        conversationId: 'conversation-recovery',
        initialPromptOrigin: `${request().creationId}:initial-prompt`,
      })
      expect(world.totalMaterializations).toBe(1)
    } finally {
      harness.close()
    }
  })
})
