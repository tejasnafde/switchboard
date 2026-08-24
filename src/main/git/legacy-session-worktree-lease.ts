import type Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getDb } from '../db/database'
import { userDataDir } from '../runtime'
import { resolveSessionWorktreePath } from './worktreePaths'

const execFileAsync = promisify(execFile)

export interface LegacySessionWorktreeInput {
  projectPath: string
  branchSlug: string
  baseRef?: string
  machineId?: string
}

export interface LegacySessionWorktreePlan {
  leaseId: string
  payloadHash: string
  requestJson: string
  machineId: string
  repositoryId: string
  projectPath: string
  worktreePath: string
  branch: string
  requestedBaseRef: string
  resolvedBaseCommit: string
}

export type LegacySessionWorktreeLeaseStatus =
  | 'reserved'
  | 'materializing'
  | 'ambiguous'
  | 'ready'

export interface LegacySessionWorktreeLeaseRecord extends LegacySessionWorktreePlan {
  status: LegacySessionWorktreeLeaseStatus
  revision: number
  error: string | null
  createdAt: number
  updatedAt: number
}

export type LegacySessionWorktreeReservation =
  | { kind: 'reserved'; record: LegacySessionWorktreeLeaseRecord }
  | { kind: 'duplicate'; record: LegacySessionWorktreeLeaseRecord }

export interface LegacySessionWorktreeLeaseStore {
  reserve(plan: LegacySessionWorktreePlan, now: number): LegacySessionWorktreeReservation
  markMaterializing(
    leaseId: string,
    expectedRevision: number,
    now: number,
  ): LegacySessionWorktreeLeaseRecord
  markAmbiguous(
    leaseId: string,
    expectedRevision: number,
    error: string,
    now: number,
  ): LegacySessionWorktreeLeaseRecord
  markReady(
    leaseId: string,
    expectedRevision: number,
    now: number,
  ): LegacySessionWorktreeLeaseRecord
}

export type LegacySessionWorktreeInspection =
  | { kind: 'absent' }
  | { kind: 'exact' }
  | { kind: 'mismatch'; reason: string }

export type LegacySessionWorktreeMaterialization =
  | { kind: 'completed' }
  | { kind: 'outcome_unknown'; reason: string }
  | { kind: 'conflict'; reason: string }

export interface LegacySessionWorktreeMaterializer {
  prepare(input: LegacySessionWorktreeInput): Promise<LegacySessionWorktreePlan>
  inspect(plan: LegacySessionWorktreePlan): Promise<LegacySessionWorktreeInspection>
  materialize(plan: LegacySessionWorktreePlan): Promise<LegacySessionWorktreeMaterialization>
}

export class LegacySessionWorktreeLeaseManager {
  private readonly inFlight = new Map<string, Promise<{ path: string; branch: string }>>()

  constructor(
    private readonly store: LegacySessionWorktreeLeaseStore,
    private readonly materializer: LegacySessionWorktreeMaterializer,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: LegacySessionWorktreeInput): Promise<{ path: string; branch: string }> {
    const plan = await this.materializer.prepare(input)
    const active = this.inFlight.get(plan.leaseId)
    if (active) return active
    const operation = this.execute(plan)
    this.inFlight.set(plan.leaseId, operation)
    try {
      return await operation
    } finally {
      if (this.inFlight.get(plan.leaseId) === operation) this.inFlight.delete(plan.leaseId)
    }
  }

  private async execute(plan: LegacySessionWorktreePlan): Promise<{ path: string; branch: string }> {
    let current = this.store.reserve(plan, this.now()).record
    if (current.status === 'ready') return result(current)

    if (current.status === 'materializing' || current.status === 'ambiguous') {
      const inspection = await this.materializer.inspect(plan)
      if (inspection.kind === 'exact') {
        current = this.store.markReady(plan.leaseId, current.revision, this.now())
        return result(current)
      }
      if (inspection.kind === 'mismatch') {
        this.store.markAmbiguous(plan.leaseId, current.revision, inspection.reason, this.now())
        throw new Error(
          `Legacy worktree does not match the reserved identity: ${inspection.reason}. ` +
          'Inspect or remove it before retrying the same request.',
        )
      }
    }

    current = this.store.markMaterializing(plan.leaseId, current.revision, this.now())
    const materialized = await this.materializer.materialize(plan)
    if (materialized.kind === 'completed') {
      current = this.store.markReady(plan.leaseId, current.revision, this.now())
      return result(current)
    }

    current = this.store.markAmbiguous(
      plan.leaseId,
      current.revision,
      materialized.reason,
      this.now(),
    )
    if (materialized.kind === 'conflict') {
      throw new Error(
        `Legacy worktree does not match the reserved identity: ${materialized.reason}. ` +
        'Inspect or remove it before retrying the same request.',
      )
    }
    throw new Error(
      `Legacy worktree creation outcome is unknown: ${materialized.reason}. ` +
      'Reconnect and retry the same request to reconcile it safely.',
    )
  }
}

function result(record: LegacySessionWorktreeLeaseRecord): { path: string; branch: string } {
  return { path: record.worktreePath, branch: record.branch }
}

interface LegacyLeaseRow {
  lease_id: string
  payload_hash: string
  request_json: string
  machine_id: string
  repository_id: string
  project_path: string
  worktree_path: string
  branch: string
  requested_base_ref: string
  resolved_base_commit: string
  status: LegacySessionWorktreeLeaseStatus
  revision: number
  error: string | null
  created_at: number
  updated_at: number
}

export class SqliteLegacySessionWorktreeLeaseStore implements LegacySessionWorktreeLeaseStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS legacy_session_worktree_leases (
        lease_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        requested_base_ref TEXT NOT NULL,
        resolved_base_commit TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved', 'materializing', 'ambiguous', 'ready')),
        revision INTEGER NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  reserve(plan: LegacySessionWorktreePlan, now: number): LegacySessionWorktreeReservation {
    return this.db.transaction((): LegacySessionWorktreeReservation => {
      const existing = this.get(plan.leaseId)
      if (existing) {
        if (existing.payloadHash !== plan.payloadHash || existing.requestJson !== plan.requestJson) {
          throw new Error(`Legacy worktree lease conflict for ${plan.leaseId}`)
        }
        return { kind: 'duplicate', record: existing }
      }
      this.db.prepare(`
        INSERT INTO legacy_session_worktree_leases (
          lease_id, payload_hash, request_json, machine_id, repository_id, project_path,
          worktree_path, branch, requested_base_ref, resolved_base_commit,
          status, revision, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1, NULL, ?, ?)
      `).run(
        plan.leaseId,
        plan.payloadHash,
        plan.requestJson,
        plan.machineId,
        plan.repositoryId,
        plan.projectPath,
        plan.worktreePath,
        plan.branch,
        plan.requestedBaseRef,
        plan.resolvedBaseCommit,
        now,
        now,
      )
      return { kind: 'reserved', record: this.required(plan.leaseId) }
    })()
  }

  markMaterializing(
    leaseId: string,
    expectedRevision: number,
    now: number,
  ): LegacySessionWorktreeLeaseRecord {
    return this.transition(leaseId, expectedRevision, 'materializing', null, now)
  }

  markAmbiguous(
    leaseId: string,
    expectedRevision: number,
    error: string,
    now: number,
  ): LegacySessionWorktreeLeaseRecord {
    return this.transition(leaseId, expectedRevision, 'ambiguous', error, now)
  }

  markReady(
    leaseId: string,
    expectedRevision: number,
    now: number,
  ): LegacySessionWorktreeLeaseRecord {
    return this.db.transaction(() => {
      const current = this.required(leaseId)
      if (current.revision !== expectedRevision) throw new Error(`Stale legacy worktree lease ${leaseId}`)
      const catalogued = this.db.prepare(`
        SELECT id, branch, resolved_base_commit
          FROM managed_worktrees
         WHERE machine_id = ? AND repository_id = ? AND worktree_path = ?
      `).get(
        current.machineId,
        current.repositoryId,
        current.worktreePath,
      ) as { id: string; branch: string; resolved_base_commit: string } | undefined
      if (
        catalogued &&
        (catalogued.id !== current.leaseId || catalogued.branch !== current.branch ||
          catalogued.resolved_base_commit !== current.resolvedBaseCommit)
      ) {
        throw new Error(`Managed worktree catalog conflict for legacy lease ${leaseId}`)
      }
      if (!catalogued) {
        this.db.prepare(`
          INSERT INTO managed_worktrees (
            id, machine_id, repository_id, project_path, worktree_path, branch,
            requested_base_ref, resolved_base_commit, management_origin, lifecycle,
            initial_owner_kind, initial_owner_id, purpose, provenance_json,
            lineage_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy', 'active',
            'legacy-session-lease', ?, 'new-chat', ?, NULL, ?, ?)
        `).run(
          current.leaseId,
          current.machineId,
          current.repositoryId,
          current.projectPath,
          current.worktreePath,
          current.branch,
          current.requestedBaseRef,
          current.resolvedBaseCommit,
          current.leaseId,
          JSON.stringify({
            surface: 'legacy',
            machineId: current.machineId,
            requestedAt: current.createdAt,
          }),
          current.createdAt,
          now,
        )
      }
      return this.transition(leaseId, expectedRevision, 'ready', null, now)
    })()
  }

  private transition(
    leaseId: string,
    expectedRevision: number,
    status: LegacySessionWorktreeLeaseStatus,
    error: string | null,
    now: number,
  ): LegacySessionWorktreeLeaseRecord {
    const updated = this.db.prepare(`
      UPDATE legacy_session_worktree_leases
         SET status = ?, revision = revision + 1, error = ?, updated_at = ?
       WHERE lease_id = ? AND revision = ?
    `).run(status, error, now, leaseId, expectedRevision)
    if (updated.changes !== 1) throw new Error(`Stale legacy worktree lease ${leaseId}`)
    return this.required(leaseId)
  }

  private get(leaseId: string): LegacySessionWorktreeLeaseRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM legacy_session_worktree_leases WHERE lease_id = ?
    `).get(leaseId) as LegacyLeaseRow | undefined
    return row ? fromRow(row) : null
  }

  private required(leaseId: string): LegacySessionWorktreeLeaseRecord {
    const record = this.get(leaseId)
    if (!record) throw new Error(`Missing legacy worktree lease ${leaseId}`)
    return record
  }
}

function fromRow(row: LegacyLeaseRow): LegacySessionWorktreeLeaseRecord {
  return {
    leaseId: row.lease_id,
    payloadHash: row.payload_hash,
    requestJson: row.request_json,
    machineId: row.machine_id,
    repositoryId: row.repository_id,
    projectPath: row.project_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    requestedBaseRef: row.requested_base_ref,
    resolvedBaseCommit: row.resolved_base_commit,
    status: row.status,
    revision: row.revision,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface PorcelainWorktree {
  path: string
  branch: string | null
  head: string
}

export type LegacyGitRunner = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

export class GitLegacySessionWorktreeMaterializer implements LegacySessionWorktreeMaterializer {
  constructor(
    private readonly dataDir: string,
    private readonly run: LegacyGitRunner = runGit,
  ) {}

  async prepare(input: LegacySessionWorktreeInput): Promise<LegacySessionWorktreePlan> {
    if (!isAbsolute(input.projectPath)) {
      throw new Error(`projectPath must be absolute: ${input.projectPath}`)
    }
    const branch = input.branchSlug.startsWith('sb/') ? input.branchSlug : `sb/${input.branchSlug}`
    const requestedBaseRef = input.baseRef ?? 'HEAD'
    await this.run(input.projectPath, ['check-ref-format', '--branch', branch])
    const resolvedBaseCommit = (await this.run(input.projectPath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${requestedBaseRef}^{commit}`,
    ])).stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedBaseCommit)) {
      throw new Error(`Git returned an invalid commit for ${requestedBaseRef}`)
    }
    const commonDirRaw = (await this.run(input.projectPath, ['rev-parse', '--git-common-dir'])).stdout.trim()
    const repositoryId = await realpath(
      isAbsolute(commonDirRaw) ? commonDirRaw : resolve(input.projectPath, commonDirRaw),
    )
    const machineId = input.machineId ?? 'local'
    const normalizedRequest = {
      projectPath: input.projectPath,
      branchSlug: input.branchSlug,
      baseRef: requestedBaseRef,
      machineId,
    }
    const requestJson = JSON.stringify(normalizedRequest)
    const payloadHash = createHash('sha256').update(requestJson).digest('hex')
    return {
      leaseId: `legacy_session_${payloadHash.slice(0, 32)}`,
      payloadHash,
      requestJson,
      machineId,
      repositoryId,
      projectPath: input.projectPath,
      worktreePath: resolveSessionWorktreePath({
        userDataDir: this.dataDir,
        projectPath: input.projectPath,
        branch,
      }),
      branch,
      requestedBaseRef,
      resolvedBaseCommit,
    }
  }

  async inspect(plan: LegacySessionWorktreePlan): Promise<LegacySessionWorktreeInspection> {
    const worktrees = parseWorktrees((await this.run(plan.projectPath, [
      'worktree',
      'list',
      '--porcelain',
    ])).stdout)
    const expectedPath = resolve(plan.worktreePath)
    const byPath = worktrees.find((worktree) => worktree.path === expectedPath)
    const byBranch = worktrees.find((worktree) => worktree.branch === plan.branch)
    const observed = byPath ?? byBranch
    if (observed) {
      if (observed.path !== expectedPath) return { kind: 'mismatch', reason: 'branch points at another worktree' }
      if (observed.branch !== plan.branch) return { kind: 'mismatch', reason: 'path uses another branch' }
      if (observed.head !== plan.resolvedBaseCommit) return { kind: 'mismatch', reason: 'worktree HEAD changed' }
      return { kind: 'exact' }
    }
    if (await exists(plan.worktreePath)) return { kind: 'mismatch', reason: 'reserved path exists outside Git' }
    try {
      await this.run(plan.projectPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${plan.branch}`,
      ])
      return { kind: 'mismatch', reason: 'reserved branch exists without its worktree' }
    } catch {
      return { kind: 'absent' }
    }
  }

  async materialize(plan: LegacySessionWorktreePlan): Promise<LegacySessionWorktreeMaterialization> {
    const before = await this.inspect(plan)
    if (before.kind !== 'absent') {
      return {
        kind: 'conflict',
        reason: before.kind === 'mismatch' ? before.reason : 'worktree already exists without this lease',
      }
    }
    await mkdir(dirname(plan.worktreePath), { recursive: true })
    try {
      await this.run(plan.projectPath, [
        'worktree',
        'add',
        '-b',
        plan.branch,
        plan.worktreePath,
        plan.resolvedBaseCommit,
      ])
    } catch (error) {
      return {
        kind: 'outcome_unknown',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    const after = await this.inspect(plan)
    return after.kind === 'exact'
      ? { kind: 'completed' }
      : {
          kind: 'outcome_unknown',
          reason: after.kind === 'mismatch' ? after.reason : 'Git returned success without the reserved worktree',
        }
  }
}

function parseWorktrees(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = []
  let current: Partial<PorcelainWorktree> = {}
  const flush = (): void => {
    if (current.path && current.head) {
      worktrees.push({
        path: resolve(current.path),
        branch: current.branch ?? null,
        head: current.head,
      })
    }
    current = {}
  }
  for (const line of `${output}\n`.split('\n')) {
    if (line === '') flush()
    else if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length)
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length)
  }
  return worktrees
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  const result = await execFileAsync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd,
    env,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

let defaultManager: LegacySessionWorktreeLeaseManager | null = null

export function createLegacySessionWorktree(
  input: LegacySessionWorktreeInput,
): Promise<{ path: string; branch: string }> {
  defaultManager ??= new LegacySessionWorktreeLeaseManager(
    new SqliteLegacySessionWorktreeLeaseStore(getDb()),
    new GitLegacySessionWorktreeMaterializer(userDataDir()),
  )
  return defaultManager.create(input)
}
