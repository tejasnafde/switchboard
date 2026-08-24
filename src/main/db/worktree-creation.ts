import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  KanbanCreationOwner,
  WorktreeCreationRequest,
  WorktreeCreationPhase,
  WorktreeCreationStatus,
} from '../../shared/worktree-creation'

export interface WorktreeCreationRecord {
  machineId: string
  creationId: string
  schemaVersion: number
  requestJson: string
  payloadHash: string
  phase: WorktreeCreationPhase
  status: WorktreeCreationStatus
  revision: number
  worktreeId: string | null
  reservedPath: string | null
  reservedBranch: string | null
  requestedBaseRef: string | null
  resolvedBaseCommit: string | null
  materializationPlanJson: string | null
  externalBoundary: string | null
  sparseReceiptJson: string | null
  setupReceiptJson: string | null
  startupReceiptJson: string | null
  warningsJson: string
  errorJson: string | null
  recoveryJson: string | null
  createdAt: number
  updatedAt: number
}

export interface ReserveWorktreeCreationInput {
  machineId: string
  creationId: string
  schemaVersion: number
  requestJson: string
  payloadHash: string
  worktreeId?: string
  reservedPath?: string
  reservedBranch?: string
  requestedBaseRef?: string
  resolvedBaseCommit?: string
  materializationPlanJson?: string
  now: number
}

export type ReserveWorktreeCreationResult =
  | { kind: 'reserved'; record: WorktreeCreationRecord }
  | { kind: 'duplicate'; record: WorktreeCreationRecord }
  | { kind: 'conflict'; record: WorktreeCreationRecord }

export interface TransitionWorktreeCreationInput {
  machineId: string
  creationId: string
  expectedRevision: number
  phase: WorktreeCreationPhase
  status: WorktreeCreationStatus
  now: number
}

export interface UpdateWorktreeCreationProgressInput extends TransitionWorktreeCreationInput {
  externalBoundary?: string
  sparseReceiptJson?: string
  setupReceiptJson?: string
  startupReceiptJson?: string
  errorJson?: string
  recoveryJson?: string
  clearError?: boolean
}

export type TransitionWorktreeCreationResult =
  | { kind: 'updated'; record: WorktreeCreationRecord }
  | { kind: 'stale'; record: WorktreeCreationRecord }
  | { kind: 'missing' }

export interface FinalizeWorktreeCleanupInput {
  machineId: string
  creationId: string
  expectedRevision: number
  disposition: 'retained' | 'removed' | 'removal_refused'
  now: number
}

export interface CommitConversationOwnerInput {
  machineId: string
  creationId: string
  expectedRevision: number
  worktree: {
    id: string
    repositoryId: string
    projectPath: string
    worktreePath: string
    branch: string
    requestedBaseRef: string
    resolvedBaseCommit: string
  }
  conversation: {
    id: string
    projectPath: string
    agentType: string
    title: string
  }
  now: number
}

export type CommitConversationOwnerResult =
  | { kind: 'committed'; record: WorktreeCreationRecord }
  | { kind: 'stale'; record: WorktreeCreationRecord }
  | { kind: 'missing' }

export type KanbanOwnerConflictReason =
  | 'card_exists'
  | 'card_missing'
  | 'stale_revision'
  | 'card_already_linked'
  | 'card_has_conversation'

export type CheckKanbanOwnerResult =
  | { kind: 'ready' }
  | { kind: 'owner_conflict'; reason: KanbanOwnerConflictReason }

export interface ReserveKanbanOwnerInput extends ReserveWorktreeCreationInput {
  owner: KanbanCreationOwner
  projectPath: string
}

export type ReserveKanbanOwnerResult =
  | ReserveWorktreeCreationResult
  | { kind: 'owner_conflict'; reason: KanbanOwnerConflictReason }

export interface CommitKanbanOwnerInput {
  machineId: string
  creationId: string
  expectedRevision: number
  worktree: CommitConversationOwnerInput['worktree']
  cardId: string
  conversation?: {
    id: string
    agentType: string
  }
  now: number
}

export type CommitKanbanOwnerResult = CommitConversationOwnerResult

export interface CommitForkOwnerInput {
  machineId: string
  creationId: string
  expectedRevision: number
  worktree: CommitConversationOwnerInput['worktree']
  conversation: {
    id: string
    projectPath: string
    agentType: string
    sessionId: string | null
    title: string
    parentConversationId: string
    forkedAtMessageId: string
    worktreePath: string
    worktreeBranch: string
    pendingHandoffFrom: string | null
  }
  messages: Array<{
    id: string
    role: string
    content: string
    timestamp: number
  }>
  now: number
}

export type CommitForkOwnerResult = CommitConversationOwnerResult

interface WorktreeCreationRow {
  machine_id: string
  creation_id: string
  schema_version: number
  request_json: string
  payload_hash: string
  phase: WorktreeCreationPhase
  status: WorktreeCreationStatus
  revision: number
  worktree_id: string | null
  reserved_path: string | null
  reserved_branch: string | null
  requested_base_ref: string | null
  resolved_base_commit: string | null
  materialization_plan_json: string | null
  external_boundary: string | null
  sparse_receipt_json: string | null
  setup_receipt_json: string | null
  startup_receipt_json: string | null
  warnings_json: string
  error_json: string | null
  recovery_json: string | null
  created_at: number
  updated_at: number
}

export function ensureWorktreeCreationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_worktrees (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      requested_base_ref TEXT NOT NULL,
      resolved_base_commit TEXT NOT NULL,
      management_origin TEXT NOT NULL CHECK (
        management_origin IN ('managed', 'adopted', 'legacy', 'legacy_unknown')
      ),
      lifecycle TEXT NOT NULL CHECK (
        lifecycle IN ('active', 'retained', 'removal_pending', 'removed', 'quarantined')
      ),
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

    CREATE INDEX IF NOT EXISTS idx_managed_worktrees_repository
      ON managed_worktrees(machine_id, repository_id, lifecycle);

    CREATE TABLE IF NOT EXISTS worktree_creations (
      machine_id TEXT NOT NULL,
      creation_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (
        phase IN (
          'pending', 'materializing', 'configuring', 'linking',
          'awaiting_setup_decision', 'provisioning', 'ready'
        )
      ),
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'ready', 'failed', 'rolled_back', 'cleanup_required', 'cancelled')
      ),
      revision INTEGER NOT NULL,
      worktree_id TEXT,
      reserved_path TEXT,
      reserved_branch TEXT,
      requested_base_ref TEXT,
      resolved_base_commit TEXT,
      materialization_plan_json TEXT,
      external_boundary TEXT,
      sparse_receipt_json TEXT,
      setup_receipt_json TEXT,
      startup_receipt_json TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      recovery_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (machine_id, creation_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_worktree_creations_status
      ON worktree_creations(machine_id, status, updated_at);
  `)

  const creationColumns = db.prepare('PRAGMA table_info(worktree_creations)').all() as Array<{ name: string }>
  if (!creationColumns.some((column) => column.name === 'materialization_plan_json')) {
    db.exec('ALTER TABLE worktree_creations ADD COLUMN materialization_plan_json TEXT')
  }

  for (const table of ['conversations', 'kanban_cards']) {
    const exists = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table)
    if (!exists) continue
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'worktree_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN worktree_id TEXT REFERENCES managed_worktrees(id)`)
    }
    if (!columns.some((column) => column.name === 'worktree_creation_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN worktree_creation_id TEXT`)
    }
    if (table === 'conversations' && !columns.some((column) => column.name === 'sidebar_role')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN sidebar_role TEXT`)
    }
  }

  backfillLegacyWorktrees(db)
}

function backfillLegacyWorktrees(db: Database.Database): void {
  type LegacyProjection = {
    owner_kind: 'conversation' | 'kanban-card'
    owner_id: string
    project_path: string
    worktree_path: string
    worktree_branch: string | null
    created_at: number
  }
  const projections: LegacyProjection[] = []
  const projectionTables: Array<{
    name: 'conversations' | 'kanban_cards'
    ownerKind: LegacyProjection['owner_kind']
    createdAt: string
  }> = []
  const conversationTable = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'
  `).get()
  if (conversationTable) {
    const columns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    const createdAt = columns.some((column) => column.name === 'created_at') ? 'created_at' : '0 AS created_at'
    projectionTables.push({ name: 'conversations', ownerKind: 'conversation', createdAt })
    projections.push(...db.prepare(`
      SELECT 'conversation' AS owner_kind, id AS owner_id, project_path,
             worktree_path, worktree_branch, ${createdAt}
        FROM conversations
       WHERE worktree_path IS NOT NULL
         AND worktree_id IS NULL
         AND worktree_creation_id IS NULL
       ORDER BY created_at, id
    `).all() as LegacyProjection[])
  }
  const kanbanTable = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_cards'
  `).get()
  if (kanbanTable) {
    const columns = db.prepare('PRAGMA table_info(kanban_cards)').all() as Array<{ name: string }>
    const createdAt = columns.some((column) => column.name === 'created_at') ? 'created_at' : '0 AS created_at'
    projectionTables.push({ name: 'kanban_cards', ownerKind: 'kanban-card', createdAt })
    projections.push(...db.prepare(`
      SELECT 'kanban-card' AS owner_kind, id AS owner_id, project_path,
             worktree_path, worktree_branch, ${createdAt}
        FROM kanban_cards
       WHERE worktree_path IS NOT NULL
         AND worktree_id IS NULL
         AND worktree_creation_id IS NULL
       ORDER BY created_at, id
    `).all() as LegacyProjection[])
  }

  const aliasesFor = (projectPath: string, worktreePath: string): LegacyProjection[] =>
    projectionTables.flatMap(({ name, ownerKind, createdAt }) => db.prepare(`
      SELECT ? AS owner_kind, id AS owner_id, project_path,
             worktree_path, worktree_branch, ${createdAt}
        FROM ${name}
       WHERE project_path = ? AND worktree_path = ?
       ORDER BY created_at, id
    `).all(ownerKind, projectPath, worktreePath) as LegacyProjection[])

  const canonicalContainment = (projectPath: string, worktreePath: string) => {
    const containmentRoot = resolve(projectPath)
    const managedRoot = resolve(containmentRoot, '.switchboard', 'worktrees')
    const normalizedWorktreePath = resolve(worktreePath)
    const relativePath = relative(managedRoot, normalizedWorktreePath)
    if (
      normalizedWorktreePath !== worktreePath
      || relativePath.length === 0
      || relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      return null
    }
    return { containmentRoot, managedRoot }
  }

  const applyBackfill = () => {
    for (const projection of projections) {
      const repositoryId = `legacy:${projection.project_path}`
      const existing = db.prepare(`
        SELECT id FROM managed_worktrees
         WHERE machine_id = 'local' AND project_path = ? AND worktree_path = ?
         ORDER BY CASE management_origin WHEN 'legacy' THEN 0 ELSE 1 END, created_at
         LIMIT 1
      `).get(projection.project_path, projection.worktree_path) as { id: string } | undefined
      const worktreeId = existing?.id ?? `legacy_${createHash('sha256')
        .update(`local\0${projection.project_path}\0${projection.worktree_path}`)
        .digest('hex')
        .slice(0, 32)}`
      if (!existing) {
        db.prepare(`
          INSERT OR IGNORE INTO managed_worktrees (
            id, machine_id, repository_id, project_path, worktree_path, branch,
            requested_base_ref, resolved_base_commit, management_origin, lifecycle,
            initial_owner_kind, initial_owner_id, purpose, provenance_json,
            lineage_json, created_at, updated_at
          ) VALUES (?, 'local', ?, ?, ?, ?, 'legacy-unknown', ?, 'legacy_unknown',
            'retained', ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          worktreeId,
          repositoryId,
          projection.project_path,
          projection.worktree_path,
          projection.worktree_branch ?? 'legacy/unknown',
          '0'.repeat(40),
          projection.owner_kind,
          projection.owner_id,
          projection.owner_kind === 'kanban-card' ? 'kanban' : 'new-chat',
          JSON.stringify({
            surface: 'legacy',
            machineId: 'local',
            requestedAt: projection.created_at,
          }),
          projection.created_at,
          projection.created_at,
        )
      }
      const catalog = db.prepare(`
        SELECT repository_id, project_path, worktree_path, branch,
               requested_base_ref, resolved_base_commit, management_origin,
               created_at
          FROM managed_worktrees
         WHERE id = ? AND machine_id = 'local'
      `).get(worktreeId) as {
        repository_id: string
        project_path: string
        worktree_path: string
        branch: string
        requested_base_ref: string
        resolved_base_commit: string
        management_origin: string
        created_at: number
      }
      let creationId: string | null = null
      const legacyCatalog = catalog.management_origin === 'legacy'
        || catalog.management_origin === 'legacy_unknown'
      const aliases = aliasesFor(catalog.project_path, catalog.worktree_path)
      const branches = new Set(aliases.map((alias) => alias.worktree_branch))
      const observedBranch = branches.size === 1 ? [...branches][0] : null
      const containment = canonicalContainment(catalog.project_path, catalog.worktree_path)
      const cleanupIdentityIsProvable = legacyCatalog
        && containment !== null
        && typeof observedBranch === 'string'
        && observedBranch.length > 0
        && observedBranch === catalog.branch
      const syntheticCreationId = `legacy_cleanup_${createHash('sha256')
        .update(`local\0${worktreeId}`)
        .digest('hex')
        .slice(0, 32)}`
      if (cleanupIdentityIsProvable) {
        creationId = syntheticCreationId
        const owner = projection.owner_kind === 'kanban-card'
          ? { kind: 'kanban-card' as const, cardId: projection.owner_id }
          : {
              kind: 'conversation' as const,
              conversationId: projection.owner_id,
              agentType: ((db.prepare(`SELECT agent_type FROM conversations WHERE id = ?`)
                .get(projection.owner_id) as { agent_type?: string } | undefined)?.agent_type ?? 'terminal') as 'terminal',
            }
        const purpose = projection.owner_kind === 'kanban-card' ? 'kanban' as const : 'new-chat' as const
        const requestedAt = Math.max(1, catalog.created_at)
        const request: WorktreeCreationRequest = {
          schemaVersion: 1,
          creationId,
          repository: { projectPath: catalog.project_path, machineId: 'local' },
          checkout: {
            baseRef: catalog.requested_base_ref,
            branch: {
              namespace: projection.owner_kind === 'kanban-card' ? 'kanban' : 'sb',
              seed: 'legacy cleanup',
            },
          },
          owner,
          purpose,
          setup: { policy: 'skip' },
          provenance: { surface: 'legacy', machineId: 'local', requestedAt },
        }
        const requestJson = JSON.stringify(request)
        const materializationPlanJson = JSON.stringify({
          repository: {
            repositoryId: catalog.repository_id,
            commonGitDir: catalog.repository_id,
            projectPath: catalog.project_path,
          },
          creationId,
          requestedBaseRef: catalog.requested_base_ref,
          resolvedBaseCommit: catalog.resolved_base_commit,
          branch: catalog.branch,
          worktreePath: catalog.worktree_path,
          managedRoot: containment.managedRoot,
          containmentRoot: containment.containmentRoot,
        })
        db.prepare(`
          INSERT OR IGNORE INTO worktree_creations (
            machine_id, creation_id, schema_version, request_json, payload_hash,
            phase, status, revision, worktree_id, reserved_path, reserved_branch,
            requested_base_ref, resolved_base_commit, materialization_plan_json,
            warnings_json, created_at, updated_at
          ) VALUES ('local', ?, 1, ?, ?, 'ready', 'ready', 1, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
        `).run(
          creationId,
          requestJson,
          createHash('sha256').update(requestJson).digest('hex'),
          worktreeId,
          catalog.worktree_path,
          catalog.branch,
          catalog.requested_base_ref,
          catalog.resolved_base_commit,
          materializationPlanJson,
          requestedAt,
          requestedAt,
        )
      } else if (legacyCatalog) {
        for (const { name } of projectionTables) {
          db.prepare(`
            UPDATE ${name}
               SET worktree_creation_id = NULL
             WHERE worktree_id = ? AND worktree_creation_id = ?
          `).run(worktreeId, syntheticCreationId)
        }
        db.prepare(`
          UPDATE worktree_creations
             SET status = 'cancelled', materialization_plan_json = NULL,
                 revision = revision + 1, updated_at = ?
           WHERE machine_id = 'local' AND creation_id = ?
        `).run(projection.created_at, syntheticCreationId)
      }
      const table = projection.owner_kind === 'conversation' ? 'conversations' : 'kanban_cards'
      db.prepare(`
        UPDATE ${table}
           SET worktree_id = ?,
               worktree_creation_id = COALESCE(worktree_creation_id, ?)
         WHERE id = ? AND worktree_path = ? AND worktree_id IS NULL
      `).run(worktreeId, creationId, projection.owner_id, projection.worktree_path)
      if (creationId) {
        db.prepare(`
          UPDATE ${table}
             SET worktree_creation_id = ?
           WHERE id = ? AND worktree_path = ? AND worktree_id = ?
             AND worktree_creation_id IS NULL
        `).run(creationId, projection.owner_id, projection.worktree_path, worktreeId)
      }
    }
  }
  if (typeof db.transaction === 'function') db.transaction(applyBackfill)()
  else applyBackfill()
}

export function listOwnedWorktreePaths(
  db: Database.Database,
  projectPath: string,
): Set<string> {
  const paths = new Set<string>()
  const reservations = db.prepare(`
    SELECT reserved_path, request_json
      FROM worktree_creations
     WHERE reserved_path IS NOT NULL
       AND status NOT IN ('rolled_back', 'cancelled')
  `).all() as Array<{ reserved_path: string; request_json: string }>
  for (const reservation of reservations) {
    try {
      const request = JSON.parse(reservation.request_json) as Partial<WorktreeCreationRequest>
      if (request.repository?.projectPath === projectPath) paths.add(reservation.reserved_path)
    } catch {
      // A malformed journal needs operator recovery, so it is never safe to
      // turn its reserved path into a stale-cleanup candidate.
      paths.add(reservation.reserved_path)
    }
  }
  const catalogRows = db.prepare(`
    SELECT worktree_path
      FROM managed_worktrees
     WHERE project_path = ? AND lifecycle != 'removed'
  `).all(projectPath) as Array<{ worktree_path: string }>
  for (const row of catalogRows) paths.add(row.worktree_path)

  for (const table of ['conversations', 'kanban_cards'] as const) {
    const exists = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table)
    if (!exists) continue
    const rows = db.prepare(`
      SELECT worktree_path
        FROM ${table}
       WHERE project_path = ? AND worktree_path IS NOT NULL
    `).all(projectPath) as Array<{ worktree_path: string }>
    for (const row of rows) paths.add(row.worktree_path)
  }
  return paths
}

export function getKanbanWorktreeCreationKey(
  db: Database.Database,
  cardId: string,
): { machineId: string; creationId: string } | null {
  const row = db.prepare(`
    SELECT wc.machine_id AS machineId, wc.creation_id AS creationId
      FROM kanban_cards k
      JOIN worktree_creations wc ON wc.creation_id = k.worktree_creation_id
     WHERE k.id = ?
       AND (
         k.worktree_id IS NULL
         OR k.worktree_id = wc.worktree_id
       )
  `).get(cardId) as { machineId: string; creationId: string } | undefined
  return row ?? null
}

function fromRow(row: WorktreeCreationRow): WorktreeCreationRecord {
  return {
    machineId: row.machine_id,
    creationId: row.creation_id,
    schemaVersion: row.schema_version,
    requestJson: row.request_json,
    payloadHash: row.payload_hash,
    phase: row.phase,
    status: row.status,
    revision: row.revision,
    worktreeId: row.worktree_id,
    reservedPath: row.reserved_path,
    reservedBranch: row.reserved_branch,
    requestedBaseRef: row.requested_base_ref,
    resolvedBaseCommit: row.resolved_base_commit,
    materializationPlanJson: row.materialization_plan_json,
    externalBoundary: row.external_boundary,
    sparseReceiptJson: row.sparse_receipt_json,
    setupReceiptJson: row.setup_receipt_json,
    startupReceiptJson: row.startup_receipt_json,
    warningsJson: row.warnings_json,
    errorJson: row.error_json,
    recoveryJson: row.recovery_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteWorktreeCreationStore {
  constructor(private readonly db: Database.Database) {}

  reserve(input: ReserveWorktreeCreationInput): ReserveWorktreeCreationResult {
    return this.db.transaction((): ReserveWorktreeCreationResult => {
      const existing = this.get({
        machineId: input.machineId,
        creationId: input.creationId,
      })
      if (existing) {
        return existing.payloadHash === input.payloadHash
          ? { kind: 'duplicate', record: existing }
          : { kind: 'conflict', record: existing }
      }

      this.db.prepare(`
        INSERT INTO worktree_creations (
          machine_id, creation_id, schema_version, request_json, payload_hash,
          phase, status, revision, worktree_id, reserved_path, reserved_branch,
          requested_base_ref, resolved_base_commit, materialization_plan_json,
          warnings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 1, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(
        input.machineId,
        input.creationId,
        input.schemaVersion,
        input.requestJson,
        input.payloadHash,
        input.worktreeId ?? null,
        input.reservedPath ?? null,
        input.reservedBranch ?? null,
        input.requestedBaseRef ?? null,
        input.resolvedBaseCommit ?? null,
        input.materializationPlanJson ?? null,
        input.now,
        input.now,
      )

      const record = this.get({
        machineId: input.machineId,
        creationId: input.creationId,
      })
      if (!record) throw new Error('worktree creation reservation disappeared')
      return { kind: 'reserved', record }
    })()
  }

  get(key: { machineId: string; creationId: string }): WorktreeCreationRecord | null {
    const row = this.db.prepare(`
      SELECT *
        FROM worktree_creations
       WHERE machine_id = ? AND creation_id = ?
    `).get(key.machineId, key.creationId) as WorktreeCreationRow | undefined
    return row ? fromRow(row) : null
  }

  listRecoverable(): WorktreeCreationRecord[] {
    const rows = this.db.prepare(`
      SELECT *
        FROM worktree_creations
       WHERE status = 'pending'
       ORDER BY created_at, machine_id, creation_id
    `).all() as WorktreeCreationRow[]
    return rows.map(fromRow)
  }

  checkKanbanOwner(
    owner: KanbanCreationOwner,
    projectPath: string,
  ): CheckKanbanOwnerResult {
    const card = this.db.prepare(`
      SELECT project_path, updated_at, conversation_id, worktree_id, worktree_creation_id
        FROM kanban_cards
       WHERE id = ?
    `).get(owner.cardId) as {
      project_path: string
      updated_at: number
      conversation_id: string | null
      worktree_id: string | null
      worktree_creation_id: string | null
    } | undefined

    if (owner.create) return card ? { kind: 'owner_conflict', reason: 'card_exists' } : { kind: 'ready' }
    if (!card || card.project_path !== projectPath) return { kind: 'owner_conflict', reason: 'card_missing' }
    if (owner.expectedRevision === undefined || card.updated_at !== owner.expectedRevision) {
      return { kind: 'owner_conflict', reason: 'stale_revision' }
    }
    if (card.worktree_id || card.worktree_creation_id) {
      return { kind: 'owner_conflict', reason: 'card_already_linked' }
    }
    if (card.conversation_id) {
      return { kind: 'owner_conflict', reason: 'card_has_conversation' }
    }
    return { kind: 'ready' }
  }

  reserveKanbanOwner(input: ReserveKanbanOwnerInput): ReserveKanbanOwnerResult {
    return this.db.transaction((): ReserveKanbanOwnerResult => {
      const ownerCheck = this.checkKanbanOwner(input.owner, input.projectPath)
      if (ownerCheck.kind === 'owner_conflict') return ownerCheck

      const reservation = this.reserve(input)
      if (reservation.kind !== 'reserved') return reservation

      if (input.owner.create) {
        const draft = input.owner.create
        this.db.prepare(`
          INSERT INTO kanban_cards (
            id, project_path, title, description, tags, status, runtime_mode, cost_cap_usd,
            worktree_creation_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.owner.cardId,
          input.projectPath,
          draft.title,
          draft.description ?? '',
          JSON.stringify(draft.tags ?? []),
          draft.status ?? 'backlog',
          draft.runtimeMode ?? 'accept-edits',
          draft.costCapUsd ?? null,
          input.creationId,
          input.now,
          input.now,
        )
      } else {
        const linked = this.db.prepare(`
          UPDATE kanban_cards
             SET worktree_creation_id = ?
           WHERE id = ?
             AND project_path = ?
             AND updated_at = ?
             AND worktree_id IS NULL
             AND worktree_creation_id IS NULL
        `).run(
          input.creationId,
          input.owner.cardId,
          input.projectPath,
          input.owner.expectedRevision,
        )
        if (linked.changes !== 1) throw new Error('kanban owner precondition changed during reservation')
      }
      return reservation
    })()
  }

  isConversationOwnerCommitted(key: { machineId: string; creationId: string }): boolean {
    const row = this.db.prepare(`
      SELECT 1
        FROM worktree_creations wc
        JOIN managed_worktrees mw ON mw.id = wc.worktree_id
        JOIN conversations c
          ON c.worktree_id = mw.id
         AND c.worktree_creation_id = wc.creation_id
       WHERE wc.machine_id = ? AND wc.creation_id = ?
       LIMIT 1
    `).get(key.machineId, key.creationId)
    return row !== undefined
  }

  isKanbanOwnerCommitted(key: { machineId: string; creationId: string }): boolean {
    const row = this.db.prepare(`
      SELECT 1
        FROM worktree_creations wc
        JOIN managed_worktrees mw ON mw.id = wc.worktree_id
        JOIN kanban_cards k
          ON k.worktree_id = mw.id
         AND k.worktree_creation_id = wc.creation_id
       WHERE wc.machine_id = ? AND wc.creation_id = ?
       LIMIT 1
    `).get(key.machineId, key.creationId)
    return row !== undefined
  }

  isForkOwnerCommitted(key: { machineId: string; creationId: string }): boolean {
    const row = this.db.prepare(`
      SELECT 1
        FROM worktree_creations wc
        JOIN managed_worktrees mw
          ON mw.id = wc.worktree_id
         AND mw.initial_owner_kind = 'fork'
        JOIN conversations c
          ON c.worktree_id = mw.id
         AND c.worktree_creation_id = wc.creation_id
       WHERE wc.machine_id = ? AND wc.creation_id = ?
       LIMIT 1
    `).get(key.machineId, key.creationId)
    return row !== undefined
  }

  transition(input: TransitionWorktreeCreationInput): TransitionWorktreeCreationResult {
    const updated = this.db.prepare(`
      UPDATE worktree_creations
         SET phase = ?, status = ?, revision = revision + 1, updated_at = ?
       WHERE machine_id = ? AND creation_id = ? AND revision = ?
    `).run(
      input.phase,
      input.status,
      input.now,
      input.machineId,
      input.creationId,
      input.expectedRevision,
    )
    const record = this.get({ machineId: input.machineId, creationId: input.creationId })
    if (!record) return { kind: 'missing' }
    return updated.changes === 1
      ? { kind: 'updated', record }
      : { kind: 'stale', record }
  }

  updateProgress(input: UpdateWorktreeCreationProgressInput): TransitionWorktreeCreationResult {
    return this.db.transaction((): TransitionWorktreeCreationResult => {
      const current = this.get(input)
      if (!current) return { kind: 'missing' }
      if (current.revision !== input.expectedRevision) return { kind: 'stale', record: current }
      const updated = this.db.prepare(`
        UPDATE worktree_creations
           SET phase = ?, status = ?, revision = revision + 1, updated_at = ?,
               external_boundary = COALESCE(?, external_boundary),
               sparse_receipt_json = COALESCE(?, sparse_receipt_json),
               setup_receipt_json = COALESCE(?, setup_receipt_json),
               startup_receipt_json = COALESCE(?, startup_receipt_json),
               error_json = CASE WHEN ? THEN NULL ELSE COALESCE(?, error_json) END,
               recovery_json = COALESCE(?, recovery_json)
         WHERE machine_id = ? AND creation_id = ? AND revision = ?
      `).run(
        input.phase,
        input.status,
        input.now,
        input.externalBoundary ?? null,
        input.sparseReceiptJson ?? null,
        input.setupReceiptJson ?? null,
        input.startupReceiptJson ?? null,
        input.clearError ? 1 : 0,
        input.errorJson ?? null,
        input.recoveryJson ?? null,
        input.machineId,
        input.creationId,
        input.expectedRevision,
      )
      if (updated.changes !== 1) throw new Error('worktree progress revision constraint failed')
      if (current.worktreeId) {
        this.db.prepare(`
          UPDATE managed_worktrees
             SET sparse_receipt_json = COALESCE(?, sparse_receipt_json),
                 setup_receipt_json = COALESCE(?, setup_receipt_json),
                 startup_receipt_json = COALESCE(?, startup_receipt_json),
                 error_json = CASE WHEN ? THEN NULL ELSE COALESCE(?, error_json) END,
                 updated_at = ?
           WHERE id = ? AND machine_id = ?
        `).run(
          input.sparseReceiptJson ?? null,
          input.setupReceiptJson ?? null,
          input.startupReceiptJson ?? null,
          input.clearError ? 1 : 0,
          input.errorJson ?? null,
          input.now,
          current.worktreeId,
          input.machineId,
        )
      }
      const record = this.get(input)
      if (!record) throw new Error('worktree creation disappeared during progress update')
      return { kind: 'updated', record }
    })()
  }

  finalizeCleanup(input: FinalizeWorktreeCleanupInput): TransitionWorktreeCreationResult {
    return this.db.transaction((): TransitionWorktreeCreationResult => {
      const current = this.get(input)
      if (!current) return { kind: 'missing' }
      if (current.revision !== input.expectedRevision) return { kind: 'stale', record: current }
      const lifecycle = input.disposition === 'removed' ? 'removed' : 'retained'

      if (current.worktreeId) {
        this.db.prepare(`
          UPDATE managed_worktrees
             SET lifecycle = ?, updated_at = ?
           WHERE id = ? AND machine_id = ?
        `).run(lifecycle, input.now, current.worktreeId, input.machineId)
      }

      if (input.disposition === 'removed') {
        for (const table of ['conversations', 'kanban_cards']) {
          const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
          const updateTimestamp = columns.some((column) => column.name === 'updated_at')
          const statement = this.db.prepare(`
            UPDATE ${table}
             SET worktree_path = NULL, worktree_branch = NULL,
                   worktree_id = NULL, worktree_creation_id = NULL
                   ${updateTimestamp ? ', updated_at = ?' : ''}
             WHERE worktree_id = ?
          `)
          if (updateTimestamp) statement.run(input.now, current.worktreeId)
          else statement.run(current.worktreeId)
        }
      }

      const updated = this.db.prepare(`
        UPDATE worktree_creations
           SET status = ?, revision = revision + 1, recovery_json = ?, updated_at = ?
         WHERE machine_id = ? AND creation_id = ? AND revision = ?
      `).run(
        input.disposition === 'removed' ? 'rolled_back' : 'cleanup_required',
        JSON.stringify({ disposition: input.disposition }),
        input.now,
        input.machineId,
        input.creationId,
        input.expectedRevision,
      )
      if (updated.changes !== 1) throw new Error('worktree cleanup revision constraint failed')
      const record = this.get(input)
      if (!record) throw new Error('worktree creation disappeared during cleanup')
      return { kind: 'updated', record }
    })()
  }

  commitConversationOwner(input: CommitConversationOwnerInput): CommitConversationOwnerResult {
    return this.db.transaction((): CommitConversationOwnerResult => {
      const current = this.get({ machineId: input.machineId, creationId: input.creationId })
      if (!current) return { kind: 'missing' }
      if (current.revision !== input.expectedRevision) return { kind: 'stale', record: current }

      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      this.db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          lineage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed', 'active', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.worktree.id,
        input.machineId,
        input.worktree.repositoryId,
        input.worktree.projectPath,
        input.worktree.worktreePath,
        input.worktree.branch,
        input.worktree.requestedBaseRef,
        input.worktree.resolvedBaseCommit,
        request.owner.kind,
        input.conversation.id,
        request.purpose,
        JSON.stringify(request.provenance),
        request.lineage ? JSON.stringify(request.lineage) : null,
        input.now,
        input.now,
      )

      this.db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, title, created_at, updated_at,
          worktree_path, worktree_branch, worktree_id, worktree_creation_id,
          sidebar_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed')
      `).run(
        input.conversation.id,
        input.conversation.projectPath,
        input.conversation.agentType,
        input.conversation.title,
        input.now,
        input.now,
        input.worktree.worktreePath,
        input.worktree.branch,
        input.worktree.id,
        input.creationId,
      )

      const transition = this.db.prepare(`
        UPDATE worktree_creations
           SET worktree_id = ?, phase = 'linking', status = 'pending',
               revision = revision + 1, updated_at = ?
         WHERE machine_id = ? AND creation_id = ? AND revision = ?
      `).run(
        input.worktree.id,
        input.now,
        input.machineId,
        input.creationId,
        input.expectedRevision,
      )
      if (transition.changes !== 1) throw new Error('worktree creation revision constraint failed')

      const record = this.get({ machineId: input.machineId, creationId: input.creationId })
      if (!record) throw new Error('worktree creation disappeared during owner commit')
      return { kind: 'committed', record }
    })()
  }

  commitKanbanOwner(input: CommitKanbanOwnerInput): CommitKanbanOwnerResult {
    return this.db.transaction((): CommitKanbanOwnerResult => {
      const current = this.get({ machineId: input.machineId, creationId: input.creationId })
      if (!current) return { kind: 'missing' }
      if (current.revision !== input.expectedRevision) return { kind: 'stale', record: current }

      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      if (request.owner.kind !== 'kanban-card' || request.owner.cardId !== input.cardId) {
        throw new Error('worktree creation journal does not match the Kanban owner')
      }
      this.db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          lineage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed', 'active', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.worktree.id,
        input.machineId,
        input.worktree.repositoryId,
        input.worktree.projectPath,
        input.worktree.worktreePath,
        input.worktree.branch,
        input.worktree.requestedBaseRef,
        input.worktree.resolvedBaseCommit,
        request.owner.kind,
        input.cardId,
        request.purpose,
        JSON.stringify(request.provenance),
        request.lineage ? JSON.stringify(request.lineage) : null,
        input.now,
        input.now,
      )

      const card = this.db.prepare(`
        UPDATE kanban_cards
           SET worktree_path = ?, worktree_branch = ?, worktree_id = ?,
               worktree_creation_id = ?, updated_at = ?
         WHERE id = ?
           AND worktree_creation_id = ?
           AND worktree_id IS NULL
      `).run(
        input.worktree.worktreePath,
        input.worktree.branch,
        input.worktree.id,
        input.creationId,
        input.now,
        input.cardId,
        input.creationId,
      )
      if (card.changes !== 1) throw new Error('kanban card owner projection changed before commit')

      if (input.conversation) {
        const cardTitle = this.db.prepare(`SELECT title FROM kanban_cards WHERE id = ?`)
          .get(input.cardId) as { title: string } | undefined
        if (!cardTitle) throw new Error('kanban card disappeared before conversation linkage')
        this.db.prepare(`
          INSERT INTO conversations (
            id, project_path, agent_type, title, created_at, updated_at,
            worktree_path, worktree_branch, worktree_id, worktree_creation_id,
            sidebar_role
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed')
        `).run(
          input.conversation.id,
          input.worktree.projectPath,
          input.conversation.agentType,
          cardTitle.title,
          input.now,
          input.now,
          input.worktree.worktreePath,
          input.worktree.branch,
          input.worktree.id,
          input.creationId,
        )
        const conversationLink = this.db.prepare(`
          UPDATE kanban_cards
             SET conversation_id = ?, status = 'in_progress', updated_at = ?
           WHERE id = ? AND worktree_id = ? AND worktree_creation_id = ?
        `).run(
          input.conversation.id,
          input.now,
          input.cardId,
          input.worktree.id,
          input.creationId,
        )
        if (conversationLink.changes !== 1) {
          throw new Error('kanban card changed before conversation linkage')
        }
      }

      const transition = this.db.prepare(`
        UPDATE worktree_creations
           SET worktree_id = ?, phase = 'linking', status = 'pending',
               revision = revision + 1, updated_at = ?
         WHERE machine_id = ? AND creation_id = ? AND revision = ?
      `).run(
        input.worktree.id,
        input.now,
        input.machineId,
        input.creationId,
        input.expectedRevision,
      )
      if (transition.changes !== 1) throw new Error('worktree creation revision constraint failed')

      const record = this.get({ machineId: input.machineId, creationId: input.creationId })
      if (!record) throw new Error('worktree creation disappeared during Kanban owner commit')
      return { kind: 'committed', record }
    })()
  }

  commitForkOwner(input: CommitForkOwnerInput): CommitForkOwnerResult {
    return this.db.transaction((): CommitForkOwnerResult => {
      const current = this.get({ machineId: input.machineId, creationId: input.creationId })
      if (!current) return { kind: 'missing' }
      if (current.revision !== input.expectedRevision) return { kind: 'stale', record: current }

      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      if (
        request.owner.kind !== 'fork'
        || request.owner.conversationId !== input.conversation.id
        || request.owner.parentConversationId !== input.conversation.parentConversationId
      ) {
        throw new Error('worktree creation journal does not match the fork owner')
      }
      if (input.conversation.projectPath !== input.worktree.projectPath) {
        throw new Error('fork conversation must retain the canonical parent project path')
      }

      this.db.prepare(`
        INSERT INTO managed_worktrees (
          id, machine_id, repository_id, project_path, worktree_path, branch,
          requested_base_ref, resolved_base_commit, management_origin, lifecycle,
          initial_owner_kind, initial_owner_id, purpose, provenance_json,
          lineage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed', 'active', 'fork', ?, ?, ?, ?, ?, ?)
      `).run(
        input.worktree.id,
        input.machineId,
        input.worktree.repositoryId,
        input.worktree.projectPath,
        input.worktree.worktreePath,
        input.worktree.branch,
        input.worktree.requestedBaseRef,
        input.worktree.resolvedBaseCommit,
        input.conversation.id,
        request.purpose,
        JSON.stringify(request.provenance),
        request.lineage ? JSON.stringify(request.lineage) : null,
        input.now,
        input.now,
      )

      this.db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, session_id, title, created_at, updated_at,
          parent_conversation_id, forked_at_message_id,
          worktree_path, worktree_branch, pending_handoff_from, sidebar_role,
          worktree_id, worktree_creation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed', ?, ?)
      `).run(
        input.conversation.id,
        input.conversation.projectPath,
        input.conversation.agentType,
        input.conversation.sessionId,
        input.conversation.title,
        input.now,
        input.now,
        input.conversation.parentConversationId,
        input.conversation.forkedAtMessageId,
        input.conversation.worktreePath,
        input.conversation.worktreeBranch,
        input.conversation.pendingHandoffFrom,
        input.worktree.id,
        input.creationId,
      )

      const insertMessage = this.db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const message of input.messages) {
        insertMessage.run(
          message.id,
          input.conversation.id,
          message.role,
          message.content,
          message.timestamp,
        )
      }

      const transition = this.db.prepare(`
        UPDATE worktree_creations
           SET worktree_id = ?, phase = 'linking', status = 'pending',
               revision = revision + 1, updated_at = ?
         WHERE machine_id = ? AND creation_id = ? AND revision = ?
      `).run(
        input.worktree.id,
        input.now,
        input.machineId,
        input.creationId,
        input.expectedRevision,
      )
      if (transition.changes !== 1) throw new Error('worktree creation revision constraint failed')

      const record = this.get({ machineId: input.machineId, creationId: input.creationId })
      if (!record) throw new Error('worktree creation disappeared during fork owner commit')
      return { kind: 'committed', record }
    })()
  }
}
