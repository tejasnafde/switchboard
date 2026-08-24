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
  type ForkWorktreeOwnerCommitInput,
  type ForkWorktreeOwnerPort,
  type ForkWorktreeOwnerPrepareInput,
  type ForkWorktreeOwnerStage,
  type GitWorktreePort,
} from '../../src/main/worktree-creation/worktree-creation-service'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const WORKTREE_PATH = '/repo/.switchboard/worktrees/fork-owner'
const WORKTREE_BRANCH = 'fork/fork-owner'

function request(): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'create-fork-owner-1',
    repository: { projectPath: '/repo', machineId: 'machine-local' },
    checkout: {
      baseRef: 'feature/source',
      branch: { namespace: 'fork', seed: 'Fork owner' },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'fork',
      conversationId: 'conversation-fork-1',
      parentConversationId: 'conversation-parent-1',
      forkedAtMessageId: 'message-2',
      upToIndex: 1,
      title: 'Parent conversation · fork/fork-owner',
    },
    purpose: 'fork',
    setup: { policy: 'skip' },
    lineage: {
      parentConversationId: 'conversation-parent-1',
      sourceMessageId: 'message-2',
    },
    provenance: {
      surface: 'desktop',
      machineId: 'machine-local',
      requestedAt: 1_777_000_000_000,
    },
  }
}

class ForkGitPort implements GitWorktreePort {
  readonly calls: string[] = []
  world: 'absent' | 'exact' = 'absent'
  rollbackFailure: Error | null = null

  constructor(private readonly trace: string[]) {}

  async resolveRepository(projectPath: string): Promise<ResolvedGitRepository> {
    this.calls.push('git.resolve')
    this.trace.push('git.resolve')
    return { repositoryId: '/repo/.git', commonGitDir: '/repo/.git', projectPath }
  }

  async planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan> {
    this.calls.push('git.plan')
    this.trace.push('git.plan')
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
    this.calls.push('git.materialize')
    this.trace.push('git.materialize')
    this.world = 'exact'
    return {
      kind: 'completed',
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      headCommit: plan.resolvedBaseCommit,
    }
  }

  async inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection> {
    this.calls.push('git.inspect')
    this.trace.push('git.inspect')
    return this.world === 'absent'
      ? { kind: 'absent' }
      : {
          kind: 'exact',
          worktreePath: plan.worktreePath,
          branch: plan.branch,
          headCommit: plan.resolvedBaseCommit,
        }
  }

  async configureSparse(): Promise<{ mode: 'cone'; directories: string[]; status: 'configured' }> {
    throw new Error('not used')
  }

  async rollbackMaterialization(): Promise<WorktreeRollbackResult> {
    this.calls.push('git.rollback')
    this.trace.push('git.rollback')
    if (this.rollbackFailure) throw this.rollbackFailure
    this.world = 'absent'
    return { kind: 'removed' }
  }
}

interface TestStage extends ForkWorktreeOwnerStage {
  artifactPath: string
}

class TestForkOwner implements ForkWorktreeOwnerPort {
  readonly calls: string[] = []
  readonly artifacts = new Set<string>()
  failPrepare = false
  failPublish = false
  failCommit = false
  failCompensate = false

  constructor(
    private readonly store: SqliteWorktreeCreationStore,
    private readonly trace: string[],
  ) {}

  async prepare(input: ForkWorktreeOwnerPrepareInput): Promise<TestStage> {
    this.calls.push('owner.prepare')
    this.trace.push('owner.prepare')
    expect(input.request.owner.kind).toBe('fork')
    expect(input.plan.worktreePath).toBe(WORKTREE_PATH)
    if (this.failPrepare) throw new Error('simulated JSONL read failure')
    return { artifactPath: `/transcripts/${input.request.owner.conversationId}.jsonl` }
  }

  async publish(stage: TestStage): Promise<void> {
    this.calls.push('owner.publish')
    this.trace.push('owner.publish')
    if (this.failPublish) throw new Error('simulated JSONL write failure')
    this.artifacts.add(stage.artifactPath)
  }

  async commit(input: ForkWorktreeOwnerCommitInput) {
    this.calls.push('owner.commit')
    this.trace.push('owner.commit')
    expect(input.worktree.projectPath).toBe('/repo')
    expect(input.worktree.worktreePath).toBe(WORKTREE_PATH)
    expect(input.request.owner.kind).toBe('fork')
    if (this.failCommit) throw new Error('simulated fork DB transaction failure')
    const result = this.store.transition({
      machineId: input.machineId,
      creationId: input.creationId,
      expectedRevision: input.expectedRevision,
      phase: 'linking',
      status: 'pending',
      now: input.now,
    })
    if (result.kind === 'missing') return result
    return result.kind === 'updated'
      ? { kind: 'committed' as const, record: result.record }
      : result
  }

  async compensate(stage: TestStage): Promise<void> {
    this.calls.push('owner.compensate')
    this.trace.push('owner.compensate')
    if (this.failCompensate) throw new Error('simulated JSONL cleanup failure')
    this.artifacts.delete(stage.artifactPath)
  }

  isCommitted(): boolean {
    return false
  }
}

function fixture() {
  const db = new Database(':memory:')
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
  ensureWorktreeCreationSchema(db)
  const trace: string[] = []
  const store = new SqliteWorktreeCreationStore(db)
  const git = new ForkGitPort(trace)
  const forkOwner = new TestForkOwner(store, trace)
  let now = 1_000
  const service = new WorktreeCreationService({
    store,
    git,
    forkOwner,
    progressSink: { publish: () => undefined },
    createWorktreeId: () => 'worktree-fork-owner-1',
    now: () => now++,
  })
  return { db, git, forkOwner, service, trace, close: () => db.close() }
}

describe('WorktreeCreationService fork owner coordination', () => {
  it('prepares before Git, publishes after materialization, and deduplicates a completed retry', async () => {
    const h = fixture()
    try {
      const first = await h.service.createWorktreeTransaction(request())
      const duplicate = await h.service.createWorktreeTransaction(request())

      expect(first).toMatchObject({ status: 'ready', projectPath: '/repo' })
      expect(duplicate).toEqual(first)
      expect(h.trace).toEqual([
        'git.resolve',
        'git.plan',
        'owner.prepare',
        'git.materialize',
        'owner.publish',
        'owner.commit',
      ])
      expect(h.forkOwner.calls).toEqual(['owner.prepare', 'owner.publish', 'owner.commit'])
      expect(h.git.calls.filter((call) => call === 'git.materialize')).toHaveLength(1)
      expect(h.forkOwner.artifacts).toEqual(new Set(['/transcripts/conversation-fork-1.jsonl']))
    } finally {
      h.close()
    }
  })

  it('does not materialize Git when provider transcript preparation fails', async () => {
    const h = fixture()
    h.forkOwner.failPrepare = true
    try {
      const result = await h.service.createWorktreeTransaction(request())

      expect(result).toMatchObject({
        status: 'rolled_back',
        error: {
          code: 'creation_compensated',
          message: expect.stringContaining('simulated JSONL read failure'),
        },
      })
      expect(h.git.calls).not.toContain('git.materialize')
      expect(h.forkOwner.artifacts.size).toBe(0)
    } finally {
      h.close()
    }
  })

  it('retries a safely rolled-back fork with the same creation identity', async () => {
    const h = fixture()
    h.forkOwner.failPrepare = true
    try {
      const rolledBack = await h.service.createWorktreeTransaction(request())
      expect(rolledBack).toMatchObject({ status: 'rolled_back', recoveryActions: ['retry'] })

      h.forkOwner.failPrepare = false
      const ready = await h.service.actOnWorktreeCreation({
        machineId: 'machine-local',
        creationId: request().creationId,
        expectedRevision: rolledBack.revision,
        action: 'retry',
      })

      expect(ready).toMatchObject({ status: 'ready', creationId: request().creationId })
      expect(h.git.calls.filter((call) => call === 'git.plan')).toHaveLength(1)
      expect(h.git.calls.filter((call) => call === 'git.materialize')).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  it('removes the exact artifact and worktree when transcript publication fails', async () => {
    const h = fixture()
    h.forkOwner.failPublish = true
    try {
      const result = await h.service.createWorktreeTransaction(request())

      expect(result).toMatchObject({
        status: 'rolled_back',
        error: {
          code: 'creation_compensated',
          message: expect.stringContaining('simulated JSONL write failure'),
        },
      })
      expect(h.forkOwner.calls).toEqual(['owner.prepare', 'owner.publish', 'owner.compensate'])
      expect(h.git.calls.at(-1)).toBe('git.rollback')
      expect(h.git.world).toBe('absent')
      expect(h.forkOwner.artifacts.size).toBe(0)
    } finally {
      h.close()
    }
  })

  it('removes the exact artifact and worktree when the fork DB commit fails', async () => {
    const h = fixture()
    h.forkOwner.failCommit = true
    try {
      const result = await h.service.createWorktreeTransaction(request())

      expect(result).toMatchObject({ status: 'rolled_back' })
      expect(h.forkOwner.calls).toEqual([
        'owner.prepare',
        'owner.publish',
        'owner.commit',
        'owner.compensate',
      ])
      expect(h.git.calls.at(-1)).toBe('git.rollback')
      expect(h.git.world).toBe('absent')
      expect(h.forkOwner.artifacts.size).toBe(0)
    } finally {
      h.close()
    }
  })

  it('preserves fork publication, artifact cleanup, and Git rollback failures together', async () => {
    const h = fixture()
    h.forkOwner.failPublish = true
    h.forkOwner.failCompensate = true
    h.git.rollbackFailure = new Error('simulated Git rollback failure')
    try {
      const result = await h.service.createWorktreeTransaction(request())

      expect(result).toMatchObject({
        status: 'cleanup_required',
        error: {
          code: 'rollback_failed',
          message: expect.stringContaining('simulated JSONL write failure'),
        },
      })
      expect(result.error?.message).toContain('simulated JSONL cleanup failure')
      expect(result.error?.message).toContain('simulated Git rollback failure')
    } finally {
      h.close()
    }
  })
})
