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
const WRONG_COMMIT = 'ffffffffffffffffffffffffffffffffffffffff'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'creation-compensation',
    repository: {
      projectPath: '/repo',
      machineId: 'machine-local',
    },
    checkout: {
      baseRef: 'HEAD',
      branch: { namespace: 'sb', seed: 'Compensation test' },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-compensation',
      agentType: 'claude-code',
      title: 'Compensation test',
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

function sparseRequest(): WorktreeCreationRequest {
  return request({
    checkout: {
      baseRef: 'HEAD',
      branch: { namespace: 'sb', seed: 'Compensation test' },
      location: 'managed-in-repo',
      sparseCheckout: { mode: 'cone', directories: ['src'] },
    },
  })
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

type GitWorld =
  | { kind: 'absent' }
  | { kind: 'exact'; plan: WorktreeMaterializationPlan; headCommit: string }
  | { kind: 'mismatch'; plan: WorktreeMaterializationPlan }

class CompensationGitPort implements GitWorktreePort {
  readonly calls: string[] = []
  readonly plans: WorktreeMaterializationPlan[] = []
  materializeResults: WorktreeMaterializationResult[] = []
  configureFailure: Error | null = null
  rollbackResult: WorktreeRollbackResult = { kind: 'removed' }
  world: GitWorld = { kind: 'absent' }

  async resolveRepository(projectPath: string): Promise<ResolvedGitRepository> {
    this.calls.push('resolveRepository')
    return {
      repositoryId: `${projectPath}/.git`,
      commonGitDir: `${projectPath}/.git`,
      projectPath,
    }
  }

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    this.calls.push('planMaterialization')
    const plan = {
      repository: intent.repository,
      creationId: intent.creationId,
      requestedBaseRef: intent.baseRef,
      resolvedBaseCommit: COMMIT,
      branch: 'sb/compensation-test-1234567890',
      worktreePath: '/repo/.switchboard/worktrees/compensation-test-1234567890',
      managedRoot: '/repo/.switchboard/worktrees',
      containmentRoot: '/repo',
    }
    this.plans.push(plan)
    return plan
  }

  async materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult> {
    this.calls.push('materialize')
    const result = this.materializeResults.shift() ?? {
      kind: 'completed' as const,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
    if (result.kind === 'completed') {
      this.world = { kind: 'exact', plan, headCommit: result.headCommit }
    }
    return result
  }

  async inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    this.calls.push('inspectMaterialization')
    if (this.world.kind === 'absent') return { kind: 'absent' }
    if (this.world.kind === 'mismatch') {
      return {
        kind: 'mismatch',
        reason: 'head_mismatch',
        observed: {
          worktreePath: this.world.plan.worktreePath,
          branch: this.world.plan.branch,
          headCommit: WRONG_COMMIT,
        },
      }
    }
    if (
      this.world.plan.worktreePath !== plan.worktreePath ||
      this.world.plan.branch !== plan.branch ||
      this.world.headCommit !== plan.resolvedBaseCommit
    ) {
      return {
        kind: 'mismatch',
        reason: 'head_mismatch',
        observed: {
          worktreePath: this.world.plan.worktreePath,
          branch: this.world.plan.branch,
          headCommit: this.world.headCommit,
        },
      }
    }
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
    return { mode: 'cone', directories, status: 'configured' }
  }

  async rollbackMaterialization(_plan: WorktreeMaterializationPlan): Promise<WorktreeRollbackResult> {
    this.calls.push('rollbackMaterialization')
    if (this.rollbackResult.kind === 'removed' || this.rollbackResult.kind === 'absent') {
      this.world = { kind: 'absent' }
    }
    return this.rollbackResult
  }
}

class FaultControllableStore extends SqliteWorktreeCreationStore {
  failOwnerLink = false
  ownerLinkAttempts = 0

  override commitConversationOwner(
    input: Parameters<SqliteWorktreeCreationStore['commitConversationOwner']>[0],
  ): ReturnType<SqliteWorktreeCreationStore['commitConversationOwner']> {
    this.ownerLinkAttempts += 1
    if (this.failOwnerLink) throw new Error('simulated owner-link transaction failure')
    return super.commitConversationOwner(input)
  }
}

class DurableProgressSink implements WorktreeCreationProgressSink {
  readonly events: WorktreeCreationProgressEvent[] = []

  constructor(private readonly store: SqliteWorktreeCreationStore) {}

  publish(event: WorktreeCreationProgressEvent): void {
    expect(this.store.get({
      machineId: 'machine-local',
      creationId: event.creationId,
    })).toMatchObject({
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
  const store = new FaultControllableStore(db)
  const git = new CompensationGitPort()
  const progressSink = new DurableProgressSink(store)
  let now = 1_000
  const service = new WorktreeCreationService({
    store,
    git,
    progressSink,
    now: () => now++,
    createWorktreeId: () => 'worktree-compensation',
  })
  return { db, store, git, progressSink, service, close: () => db.close() }
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('WorktreeCreationService compensation', () => {
  it('records a definite materialization failure and safely retries the same creation identity', async () => {
    const harness = fixture()
    try {
      harness.git.materializeResults = [{
        kind: 'conflict',
        worktreePath: '/repo/.switchboard/worktrees/compensation-test-1234567890',
        branch: 'sb/compensation-test-1234567890',
        reason: 'path_exists',
      }]

      const failed = await harness.service.createWorktreeTransaction(request())

      expect(failed).toMatchObject({ phase: 'materializing', status: 'failed' })
      expect(failed.recoveryActions).toContain('retry')
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)

      const retried = await harness.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: failed.revision,
        action: 'retry',
      })

      expect(retried).toMatchObject({ phase: 'ready', status: 'ready' })
      expect(harness.git.calls.filter((call) => call === 'materialize')).toHaveLength(2)
      expect(count(harness.db, 'managed_worktrees')).toBe(1)
      expect(count(harness.db, 'conversations')).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('rolls back an exact worktree and branch when sparse configuration definitely fails', async () => {
    const harness = fixture()
    try {
      harness.git.configureFailure = new Error('simulated sparse checkout failure')

      const rolledBack = await harness.service.createWorktreeTransaction(sparseRequest())

      expect(rolledBack).toMatchObject({ phase: 'configuring', status: 'rolled_back' })
      expect(harness.git.calls).toEqual([
        'resolveRepository',
        'planMaterialization',
        'materialize',
        'configureSparse',
        'rollbackMaterialization',
      ])
      expect(harness.git.world).toEqual({ kind: 'absent' })
      expect(harness.store.ownerLinkAttempts).toBe(0)
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('rolls back before external commands when the atomic owner link fails', async () => {
    const harness = fixture()
    try {
      harness.store.failOwnerLink = true

      const rolledBack = await harness.service.createWorktreeTransaction(sparseRequest())

      expect(rolledBack).toMatchObject({ phase: 'linking', status: 'rolled_back' })
      expect(harness.git.calls).toContain('configureSparse')
      expect(harness.git.calls.at(-1)).toBe('rollbackMaterialization')
      expect(harness.git.world).toEqual({ kind: 'absent' })
      expect(harness.store.ownerLinkAttempts).toBe(1)
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('retains a worktree as cleanup-required when exact rollback is refused', async () => {
    const harness = fixture()
    try {
      harness.git.configureFailure = new Error('simulated sparse checkout failure')
      harness.git.rollbackResult = { kind: 'refused', reason: 'identity_mismatch' }

      const retained = await harness.service.createWorktreeTransaction(sparseRequest())

      expect(retained).toMatchObject({ phase: 'configuring', status: 'cleanup_required' })
      expect(retained.recoveryActions).toEqual(expect.arrayContaining(['retain', 'remove']))
      expect(harness.git.calls.at(-1)).toBe('rollbackMaterialization')
      expect(harness.git.world.kind).toBe('exact')
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('inspects and quarantines a wrong-head materialization instead of throwing unjournaled', async () => {
    const harness = fixture()
    try {
      harness.git.materializeResults = [{
        kind: 'completed',
        worktreePath: '/repo/.switchboard/worktrees/compensation-test-1234567890',
        branch: 'sb/compensation-test-1234567890',
        headCommit: WRONG_COMMIT,
      }]

      const retained = await harness.service.createWorktreeTransaction(request())

      expect(retained).toMatchObject({ phase: 'materializing', status: 'cleanup_required' })
      expect(retained.recoveryActions).toEqual(expect.arrayContaining(['retain', 'remove']))
      expect(harness.git.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(1)
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ status: 'cleanup_required' })
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('makes an absent outcome-unknown materialization retryable without rollback', async () => {
    const harness = fixture()
    try {
      harness.git.materializeResults = [{
        kind: 'outcome_unknown',
        worktreePath: '/repo/.switchboard/worktrees/compensation-test-1234567890',
        branch: 'sb/compensation-test-1234567890',
        reason: 'git response stream closed',
      }]

      const failed = await harness.service.createWorktreeTransaction(request())

      expect(failed).toMatchObject({ phase: 'materializing', status: 'failed' })
      expect(failed.recoveryActions).toContain('retry')
      expect(harness.git.calls.filter((call) => call === 'inspectMaterialization')).toHaveLength(1)
      expect(harness.git.calls).not.toContain('rollbackMaterialization')
      expect(harness.store.get({
        machineId: 'machine-local',
        creationId: request().creationId,
      })).toMatchObject({ phase: 'materializing', status: 'failed' })
      expect(count(harness.db, 'managed_worktrees')).toBe(0)
      expect(count(harness.db, 'conversations')).toBe(0)
    } finally {
      harness.close()
    }
  })
})
