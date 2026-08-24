import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  LegacySessionWorktreeLeaseManager,
  SqliteLegacySessionWorktreeLeaseStore,
  type LegacySessionWorktreeLeaseRecord,
  type LegacySessionWorktreeLeaseStore,
  type LegacySessionWorktreeMaterializer,
  type LegacySessionWorktreePlan,
} from '../../src/main/git/legacy-session-worktree-lease'

const input = {
  projectPath: '/repo',
  branchSlug: 'feature-one',
  baseRef: 'main',
  machineId: 'local',
}

function plan(): LegacySessionWorktreePlan {
  return {
    leaseId: 'legacy-session-lease-1',
    payloadHash: 'hash-1',
    requestJson: JSON.stringify(input),
    machineId: 'local',
    repositoryId: '/repo/.git',
    projectPath: '/repo',
    worktreePath: '/data/worktrees/repo/feature-one',
    branch: 'sb/feature-one',
    requestedBaseRef: 'main',
    resolvedBaseCommit: 'a'.repeat(40),
  }
}

describe('legacy session worktree compatibility lease', () => {
  it('durably reserves and marks the lease before crossing the Git boundary', async () => {
    const store = new MemoryLeaseStore()
    const materializer = new FakeMaterializer(plan())
    materializer.onMaterialize = () => {
      expect(store.record?.status).toBe('materializing')
    }
    const manager = new LegacySessionWorktreeLeaseManager(store, materializer, () => 100)

    await expect(manager.create(input)).resolves.toEqual({
      path: plan().worktreePath,
      branch: plan().branch,
    })

    expect(store.operations).toEqual(['reserve', 'materializing', 'ready'])
    expect(materializer.materializeCalls).toBe(1)
    expect(store.record).toMatchObject({ status: 'ready', revision: 3 })
  })

  it('replays a completed duplicate without touching Git again', async () => {
    const ready = record('ready', 3)
    const store = new MemoryLeaseStore(ready)
    const materializer = new FakeMaterializer(plan())
    const manager = new LegacySessionWorktreeLeaseManager(store, materializer, () => 200)

    await expect(manager.create(input)).resolves.toEqual({
      path: plan().worktreePath,
      branch: plan().branch,
    })

    expect(materializer.inspectCalls).toBe(0)
    expect(materializer.materializeCalls).toBe(0)
    expect(store.operations).toEqual(['reserve'])
  })

  it('keeps an outcome-unknown lease ambiguous and reconciles exact identity on retry', async () => {
    const store = new MemoryLeaseStore()
    const materializer = new FakeMaterializer(plan())
    materializer.materializeResult = { kind: 'outcome_unknown', reason: 'connection closed' }
    const manager = new LegacySessionWorktreeLeaseManager(store, materializer, () => 300)

    await expect(manager.create(input)).rejects.toThrow(/outcome is unknown.*retry the same request/i)
    expect(store.record).toMatchObject({ status: 'ambiguous', revision: 3 })
    expect(materializer.materializeCalls).toBe(1)

    materializer.inspectResult = { kind: 'exact' }
    await expect(manager.create(input)).resolves.toEqual({
      path: plan().worktreePath,
      branch: plan().branch,
    })

    expect(materializer.materializeCalls).toBe(1)
    expect(materializer.inspectCalls).toBe(1)
    expect(store.record).toMatchObject({ status: 'ready', revision: 4 })
  })

  it('retries the same lease only after reconciliation proves path and branch absent', async () => {
    const store = new MemoryLeaseStore(record('ambiguous', 3))
    const materializer = new FakeMaterializer(plan())
    materializer.inspectResult = { kind: 'absent' }
    const manager = new LegacySessionWorktreeLeaseManager(store, materializer, () => 400)

    await expect(manager.create(input)).resolves.toEqual({
      path: plan().worktreePath,
      branch: plan().branch,
    })

    expect(materializer.inspectCalls).toBe(1)
    expect(materializer.materializeCalls).toBe(1)
    expect(store.record?.status).toBe('ready')
  })

  it('refuses a mismatched path or branch instead of adopting or recreating it', async () => {
    const store = new MemoryLeaseStore(record('materializing', 2))
    const materializer = new FakeMaterializer(plan())
    materializer.inspectResult = {
      kind: 'mismatch',
      reason: 'branch points at another worktree',
    }
    const manager = new LegacySessionWorktreeLeaseManager(store, materializer, () => 500)

    await expect(manager.create(input)).rejects.toThrow(/does not match the reserved identity/i)

    expect(materializer.materializeCalls).toBe(0)
    expect(store.record?.status).toBe('ambiguous')
  })

  it('persists the lease and catalogs a successful legacy worktree atomically', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE managed_worktrees (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        requested_base_ref TEXT NOT NULL,
        resolved_base_commit TEXT NOT NULL,
        management_origin TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        initial_owner_kind TEXT NOT NULL,
        initial_owner_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        lineage_json TEXT,
        sparse_receipt_json TEXT,
        setup_receipt_json TEXT,
        startup_receipt_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(machine_id, repository_id, worktree_path)
      );
    `)
    const store = new SqliteLegacySessionWorktreeLeaseStore(db)

    const reserved = store.reserve(plan(), 10)
    expect(reserved.kind).toBe('reserved')
    const materializing = store.markMaterializing(plan().leaseId, reserved.record.revision, 11)
    const ready = store.markReady(plan().leaseId, materializing.revision, 12)

    expect(ready).toMatchObject({ status: 'ready', revision: 3 })
    expect(db.prepare('SELECT status FROM legacy_session_worktree_leases').get()).toEqual({
      status: 'ready',
    })
    expect(db.prepare(`
      SELECT management_origin, initial_owner_kind, initial_owner_id, worktree_path, branch
        FROM managed_worktrees
    `).get()).toEqual({
      management_origin: 'legacy',
      initial_owner_kind: 'legacy-session-lease',
      initial_owner_id: plan().leaseId,
      worktree_path: plan().worktreePath,
      branch: plan().branch,
    })
    db.close()
  })
})

function record(
  status: LegacySessionWorktreeLeaseRecord['status'],
  revision: number,
): LegacySessionWorktreeLeaseRecord {
  return {
    ...plan(),
    status,
    revision,
    error: status === 'ambiguous' ? 'unknown' : null,
    createdAt: 1,
    updatedAt: 1,
  }
}

class MemoryLeaseStore implements LegacySessionWorktreeLeaseStore {
  operations: string[] = []

  constructor(public record: LegacySessionWorktreeLeaseRecord | null = null) {}

  reserve(value: LegacySessionWorktreePlan, now: number) {
    this.operations.push('reserve')
    if (this.record) return { kind: 'duplicate' as const, record: this.record }
    this.record = {
      ...value,
      status: 'reserved',
      revision: 1,
      error: null,
      createdAt: now,
      updatedAt: now,
    }
    return { kind: 'reserved' as const, record: this.record }
  }

  markMaterializing(leaseId: string, expectedRevision: number, now: number) {
    this.operations.push('materializing')
    return this.update(leaseId, expectedRevision, 'materializing', null, now)
  }

  markAmbiguous(leaseId: string, expectedRevision: number, error: string, now: number) {
    this.operations.push('ambiguous')
    return this.update(leaseId, expectedRevision, 'ambiguous', error, now)
  }

  markReady(leaseId: string, expectedRevision: number, now: number) {
    this.operations.push('ready')
    return this.update(leaseId, expectedRevision, 'ready', null, now)
  }

  private update(
    leaseId: string,
    expectedRevision: number,
    status: LegacySessionWorktreeLeaseRecord['status'],
    error: string | null,
    now: number,
  ) {
    if (!this.record || this.record.leaseId !== leaseId || this.record.revision !== expectedRevision) {
      throw new Error('stale lease')
    }
    this.record = {
      ...this.record,
      status,
      revision: expectedRevision + 1,
      error,
      updatedAt: now,
    }
    return this.record
  }
}

class FakeMaterializer implements LegacySessionWorktreeMaterializer {
  inspectCalls = 0
  materializeCalls = 0
  inspectResult: Awaited<ReturnType<LegacySessionWorktreeMaterializer['inspect']>> = { kind: 'absent' }
  materializeResult: Awaited<ReturnType<LegacySessionWorktreeMaterializer['materialize']>> = {
    kind: 'completed',
  }
  onMaterialize: () => void = () => {}

  constructor(private readonly value: LegacySessionWorktreePlan) {}

  async prepare() {
    return this.value
  }

  async inspect() {
    this.inspectCalls += 1
    return this.inspectResult
  }

  async materialize() {
    this.materializeCalls += 1
    this.onMaterialize()
    return this.materializeResult
  }
}
