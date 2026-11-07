import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import {
  BRIDGE_CALL_RETENTION_MS,
  bridgeCallTransitionAllowed,
  bridgePolicyModesValid,
  canonicalBridgeCheck,
  parseBridgeCheckDefinitions,
  type BridgeCallState,
  type BridgeCheckDefinition,
  type BridgeCheckSummary,
  type BridgeErrorCode,
  type BridgeOperation,
  type BridgeOriginMarker,
  type BridgeOriginStopState,
  type BridgeProjectActions,
  type BridgeProjectPolicy,
  type BridgeStopResult,
} from '@shared/bridge'
import type { RuntimeMode } from '@shared/provider-events'
import type { AgentType } from '@shared/types'
import { getDb } from './database'
import { resolveRootThreadId } from './conversations'
import { createMainLogger } from '../logger'

const log = createMainLogger('db:bridge')

// ─── Instinct bridge: project policies, call ledger, origins, stop generation ──
//
// Origins are keyed by the ROOT conversation id (`resolveRootThreadId`). A
// call record past its retention keeps its key, input hash and call id as a
// tombstone, so the same key never starts new work.

export function ensureBridgeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_project_policies (
      project_id          TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      machine_id          TEXT NOT NULL,
      canonical_local_root TEXT NOT NULL,
      allowed_agents      TEXT NOT NULL,
      default_agent       TEXT,
      default_model       TEXT,
      default_mode        TEXT NOT NULL,
      maximum_mode        TEXT NOT NULL,
      actions             TEXT NOT NULL,
      revision            INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bridge_calls (
      call_id           TEXT PRIMARY KEY,
      operation         TEXT NOT NULL,
      idempotency_key   TEXT NOT NULL,
      input_hash        TEXT NOT NULL,
      machine_id        TEXT,
      target            TEXT,
      policy_revision   INTEGER,
      state             TEXT NOT NULL,
      error_code        TEXT,
      non_delivery_confirmed INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      retired_at        INTEGER,
      UNIQUE (operation, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_calls_live ON bridge_calls(created_at) WHERE retired_at IS NULL;
    CREATE TABLE IF NOT EXISTS bridge_origins (
      conversation_id  TEXT PRIMARY KEY,
      call_id          TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      machine_id       TEXT NOT NULL,
      policy_revision  INTEGER NOT NULL,
      stop_generation  INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bridge_stop_generation (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      generation  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bridge_check_runs (
      run_id          TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      project_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      execution_root_revision INTEGER,
      commit_sha      TEXT,
      tree_before     TEXT NOT NULL,
      tree_after      TEXT,
      dirty           INTEGER NOT NULL,
      state           TEXT NOT NULL,
      exit_code       INTEGER,
      signal          TEXT,
      log_digest      TEXT,
      log_bytes       INTEGER,
      definition_changed INTEGER NOT NULL DEFAULT 0,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER
    );
    -- One run per chat, definition and source snapshot: a read never starts a second.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_check_runs_key
      ON bridge_check_runs(conversation_id, definition_hash, tree_before);
    CREATE INDEX IF NOT EXISTS idx_bridge_check_runs_chat ON bridge_check_runs(conversation_id, started_at);
  `)
  const policyColumns = columnsOf(db, 'bridge_project_policies')
  // The named checks the owner chose, each a program and an argument array.
  if (!policyColumns.has('checks')) db.exec(`ALTER TABLE bridge_project_policies ADD COLUMN checks TEXT`)
  const callColumns = columnsOf(db, 'bridge_calls')
  // What an accepted call did (the actual delivery, the stop status), for a replay.
  if (!callColumns.has('result')) db.exec('ALTER TABLE bridge_calls ADD COLUMN result TEXT')
  const originColumns = columnsOf(db, 'bridge_origins')
  // Who started the work: a local agent, or the owner through the relay (the control lease covers only that).
  if (!originColumns.has('source'))
    db.exec(`ALTER TABLE bridge_origins ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`)
  // The last stop's state on this chat; NULL again after the next bridge call.
  if (!originColumns.has('stop_state')) db.exec('ALTER TABLE bridge_origins ADD COLUMN stop_state TEXT')
  // The checkout as it stood when the last bridge call reached the chat: the baseline a read diffs against.
  if (!originColumns.has('baseline_tree')) db.exec('ALTER TABLE bridge_origins ADD COLUMN baseline_tree TEXT')
  if (!originColumns.has('baseline_commit')) db.exec('ALTER TABLE bridge_origins ADD COLUMN baseline_commit TEXT')
  if (!originColumns.has('baseline_at')) db.exec('ALTER TABLE bridge_origins ADD COLUMN baseline_at INTEGER')
  const stopColumns = columnsOf(db, 'bridge_stop_generation')
  if (!stopColumns.has('killed'))
    db.exec('ALTER TABLE bridge_stop_generation ADD COLUMN killed INTEGER NOT NULL DEFAULT 0')
  // A Stop all made here that the relay has not confirmed yet: sent again on the next welcome.
  if (!stopColumns.has('kill_pending'))
    db.exec('ALTER TABLE bridge_stop_generation ADD COLUMN kill_pending INTEGER NOT NULL DEFAULT 0')
  if (!stopColumns.has('last_result')) db.exec('ALTER TABLE bridge_stop_generation ADD COLUMN last_result TEXT')
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
}

// ─── Project policies ───────────────────────────────────────────

export interface StoredBridgeProjectPolicy extends BridgeProjectPolicy {
  revision: number
  updated_at: number
}

type PolicyRow = Omit<StoredBridgeProjectPolicy, 'allowed_agents' | 'actions' | 'checks'> & {
  allowed_agents: string
  actions: string
  checks: string | null
}

const toPolicy = (r: PolicyRow): StoredBridgeProjectPolicy => ({
  ...r,
  allowed_agents: JSON.parse(r.allowed_agents) as AgentType[],
  actions: JSON.parse(r.actions) as BridgeProjectActions,
  checks: parseStoredChecks(r.project_id, r.checks),
  default_mode: r.default_mode as RuntimeMode,
  maximum_mode: r.maximum_mode as RuntimeMode,
})

/** A row an older build wrote has no checks; one this build cannot read counts as none. */
function parseStoredChecks(projectId: string, raw: string | null): BridgeCheckDefinition[] {
  if (!raw) return []
  try {
    return parseBridgeCheckDefinitions(JSON.parse(raw))
  } catch (err) {
    log.warn('stored bridge checks are not valid JSON; the project has no configured check', { projectId, err })
    return []
  }
}

/** Inserts or replaces a policy and raises its revision, so a call resolved under the old one can tell. */
export function saveBridgeProjectPolicy(policy: BridgeProjectPolicy): StoredBridgeProjectPolicy {
  if (!bridgePolicyModesValid(policy)) throw new Error('Bridge policy default mode is above its maximum mode')
  getDb()
    .prepare(
      `INSERT INTO bridge_project_policies (project_id, label, machine_id, canonical_local_root, allowed_agents,
         default_agent, default_model, default_mode, maximum_mode, actions, checks, revision, updated_at)
       VALUES (@project_id, @label, @machine_id, @canonical_local_root, @allowed_agents,
         @default_agent, @default_model, @default_mode, @maximum_mode, @actions, @checks, 1, @now)
       ON CONFLICT(project_id) DO UPDATE SET label = @label, machine_id = @machine_id,
         canonical_local_root = @canonical_local_root, allowed_agents = @allowed_agents,
         default_agent = @default_agent, default_model = @default_model, default_mode = @default_mode,
         maximum_mode = @maximum_mode, actions = @actions, checks = @checks,
         revision = revision + 1, updated_at = @now`,
    )
    .run({
      ...policy,
      allowed_agents: JSON.stringify(policy.allowed_agents),
      actions: JSON.stringify(policy.actions),
      checks: JSON.stringify(parseBridgeCheckDefinitions(policy.checks)),
      now: Date.now(),
    })
  return getBridgeProjectPolicy(policy.project_id)!
}

export function getBridgeProjectPolicy(projectId: string): StoredBridgeProjectPolicy | null {
  const row = getDb().prepare('SELECT * FROM bridge_project_policies WHERE project_id = ?').get(projectId) as
    | PolicyRow
    | undefined
  return row ? toPolicy(row) : null
}

/** The owner took the project off the allowlist. True when a policy was there. */
export function deleteBridgeProjectPolicy(projectId: string): boolean {
  return getDb().prepare('DELETE FROM bridge_project_policies WHERE project_id = ?').run(projectId).changes > 0
}

export function listBridgeProjectPolicies(): StoredBridgeProjectPolicy[] {
  return (getDb().prepare('SELECT * FROM bridge_project_policies ORDER BY label').all() as PolicyRow[]).map(toPolicy)
}

// ─── Call ledger ────────────────────────────────────────────────

export interface BridgeCallRecord {
  callId: string
  operation: BridgeOperation
  idempotencyKey: string
  inputHash: string
  machineId: string | null
  /** The resolved target as JSON, fixed at first resolution. Null on a tombstone. */
  target: string | null
  /** What the accepted action did, as JSON. Null until then and on a tombstone. */
  result: string | null
  policyRevision: number | null
  state: BridgeCallState
  errorCode: BridgeErrorCode | null
  nonDeliveryConfirmed: boolean | null
  createdAt: number
  updatedAt: number
  retiredAt: number | null
}

type CallRow = {
  call_id: string
  operation: BridgeOperation
  idempotency_key: string
  input_hash: string
  machine_id: string | null
  target: string | null
  result: string | null
  policy_revision: number | null
  state: BridgeCallState
  error_code: BridgeErrorCode | null
  non_delivery_confirmed: number | null
  created_at: number
  updated_at: number
  retired_at: number | null
}

const toCall = (r: CallRow): BridgeCallRecord => ({
  callId: r.call_id,
  operation: r.operation,
  idempotencyKey: r.idempotency_key,
  inputHash: r.input_hash,
  machineId: r.machine_id,
  target: r.target,
  result: r.result,
  policyRevision: r.policy_revision,
  state: r.state,
  errorCode: r.error_code,
  nonDeliveryConfirmed: r.non_delivery_confirmed === null ? null : r.non_delivery_confirmed === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  retiredAt: r.retired_at,
})

export type BridgeReservation =
  | { kind: 'reserved'; call: BridgeCallRecord }
  | { kind: 'existing'; call: BridgeCallRecord }
  | { kind: 'conflict'; code: 'idempotency_conflict'; callId: string }
  | { kind: 'retired'; code: 'request_retired'; callId: string }

/**
 * Reserves `(operation, idempotencyKey)` before any dispatch. The same key and
 * hash returns the existing record with its first target; another hash is a
 * conflict; a key past retention is retired, never new work. `callId` is the
 * id the relay reserved, stored as given; a local call omits it and gets one.
 */
export function reserveBridgeCall(input: {
  callId?: string
  operation: BridgeOperation
  idempotencyKey: string
  inputHash: string
  machineId: string | null
  target: unknown
  policyRevision: number | null
  now?: number
}): BridgeReservation {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db
    .transaction((): BridgeReservation => {
      const row = db
        .prepare('SELECT * FROM bridge_calls WHERE operation = ? AND idempotency_key = ?')
        .get(input.operation, input.idempotencyKey) as CallRow | undefined
      if (row) {
        if (bridgeCallRetired(toCall(row), now)) {
          return { kind: 'retired', code: 'request_retired', callId: row.call_id }
        }
        if (row.input_hash !== input.inputHash) {
          return { kind: 'conflict', code: 'idempotency_conflict', callId: row.call_id }
        }
        return { kind: 'existing', call: toCall(row) }
      }
      const callId = input.callId ?? `bcall_${randomUUID()}`
      db.prepare(
        `INSERT INTO bridge_calls (call_id, operation, idempotency_key, input_hash, machine_id, target,
         policy_revision, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)`,
      ).run(
        callId,
        input.operation,
        input.idempotencyKey,
        input.inputHash,
        input.machineId,
        input.target === undefined ? null : JSON.stringify(input.target),
        input.policyRevision,
        now,
        now,
      )
      return { kind: 'reserved', call: getBridgeCall(callId)! }
    })
    .immediate()
}

export function getBridgeCall(callId: string): BridgeCallRecord | null {
  const row = getDb().prepare('SELECT * FROM bridge_calls WHERE call_id = ?').get(callId) as CallRow | undefined
  return row ? toCall(row) : null
}

/** The call an earlier attempt reserved under this key, tombstone included. */
export function findBridgeCall(operation: BridgeOperation, idempotencyKey: string): BridgeCallRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM bridge_calls WHERE operation = ? AND idempotency_key = ?')
    .get(operation, idempotencyKey) as CallRow | undefined
  return row ? toCall(row) : null
}

export function bridgeCallRetired(call: Pick<BridgeCallRecord, 'retiredAt' | 'createdAt'>, now = Date.now()): boolean {
  return call.retiredAt !== null || now - call.createdAt >= BRIDGE_CALL_RETENTION_MS
}

/**
 * Moves a call along its delivery states. False when the move is not allowed
 * from the stored state (an accepted or rejected call stays so) or the call is
 * a tombstone. An omitted detail keeps its stored value.
 */
export function updateBridgeCallState(
  callId: string,
  to: BridgeCallState,
  detail: { errorCode?: BridgeErrorCode; nonDeliveryConfirmed?: boolean; result?: unknown } = {},
): boolean {
  const db = getDb()
  return db
    .transaction((): boolean => {
      const row = db.prepare('SELECT state, retired_at FROM bridge_calls WHERE call_id = ?').get(callId) as
        | Pick<CallRow, 'state' | 'retired_at'>
        | undefined
      if (!row || row.retired_at !== null || !bridgeCallTransitionAllowed(row.state, to)) return false
      db.prepare(
        `UPDATE bridge_calls SET state = ?, error_code = COALESCE(?, error_code),
         non_delivery_confirmed = COALESCE(?, non_delivery_confirmed), result = COALESCE(?, result),
         updated_at = ? WHERE call_id = ?`,
      ).run(
        to,
        detail.errorCode ?? null,
        detail.nonDeliveryConfirmed === undefined ? null : detail.nonDeliveryConfirmed ? 1 : 0,
        detail.result === undefined ? null : JSON.stringify(detail.result),
        Date.now(),
        callId,
      )
      return true
    })
    .immediate()
}

/** Turns every call older than the retention into a tombstone: key, hash, call id and state stay. */
export function retireExpiredBridgeCalls(now = Date.now()): number {
  return getDb()
    .prepare(
      `UPDATE bridge_calls SET retired_at = ?, target = NULL, result = NULL, machine_id = NULL,
         policy_revision = NULL WHERE retired_at IS NULL AND created_at <= ?`,
    )
    .run(now, now - BRIDGE_CALL_RETENTION_MS).changes
}

/**
 * At start, before any queued bridge work: a call that was only recorded never
 * reached a provider, so it is rejected with confirmed non-delivery; one that
 * was dispatching may have, so it becomes `delivery_unknown` for reconciling.
 */
export function recoverBridgeCalls(): { rejected: number; unknown: number } {
  const db = getDb()
  return db
    .transaction(() => {
      const now = Date.now()
      const rejected = db
        .prepare(
          `UPDATE bridge_calls SET state = 'rejected', non_delivery_confirmed = 1,
           updated_at = ? WHERE state = 'recorded' AND retired_at IS NULL`,
        )
        .run(now).changes
      const unknown = db
        .prepare(
          `UPDATE bridge_calls SET state = 'delivery_unknown', error_code = 'delivery_unknown', updated_at = ?
         WHERE state = 'dispatching' AND retired_at IS NULL`,
        )
        .run(now).changes
      return { rejected, unknown }
    })
    .immediate()
}

// ─── Origins ────────────────────────────────────────────────────

/** `local`: a local agent's MCP call. `relay`: the owner through the relay, held by the control lease. */
export type BridgeOriginSource = 'local' | 'relay'

export interface BridgeOrigin {
  conversationId: string
  callId: string
  projectId: string
  machineId: string
  policyRevision: number
  /** The stop generation of the latest bridge call into the chat. */
  stopGeneration: number
  source: BridgeOriginSource
  stopState: BridgeOriginStopState | null
  /** The checkout when the last bridge call reached the chat: a read diffs against it. */
  baselineTree: string | null
  baselineCommit: string | null
  baselineAt: number | null
  createdAt: number
}

type OriginRow = {
  conversation_id: string
  call_id: string
  project_id: string
  machine_id: string
  policy_revision: number
  stop_generation: number
  source: BridgeOriginSource
  stop_state: BridgeOriginStopState | null
  baseline_tree: string | null
  baseline_commit: string | null
  baseline_at: number | null
  created_at: number
}

const toOrigin = (r: OriginRow): BridgeOrigin => ({
  conversationId: r.conversation_id,
  callId: r.call_id,
  projectId: r.project_id,
  machineId: r.machine_id,
  policyRevision: r.policy_revision,
  stopGeneration: r.stop_generation,
  source: r.source,
  stopState: r.stop_state,
  baselineTree: r.baseline_tree,
  baselineCommit: r.baseline_commit,
  baselineAt: r.baseline_at,
  createdAt: r.created_at,
})

/**
 * Marks a chat as bridge-started, under its root id. The first call, project
 * and revision stay. A later call into the same chat stamps the current stop
 * generation, clears the last stop state, and makes the source `relay` once
 * any relay call reached it.
 */
export function recordBridgeOrigin(o: {
  conversationId: string
  callId: string
  projectId: string
  machineId: string
  policyRevision: number
  source: BridgeOriginSource
}): BridgeOrigin {
  const db = getDb()
  const root = resolveRootThreadId(o.conversationId, db)
  db.prepare(
    `INSERT INTO bridge_origins (conversation_id, call_id, project_id, machine_id, policy_revision, stop_generation,
       source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
       stop_generation = excluded.stop_generation, stop_state = NULL,
       source = CASE WHEN excluded.source = 'relay' THEN 'relay' ELSE source END`,
  ).run(root, o.callId, o.projectId, o.machineId, o.policyRevision, readBridgeStopGeneration(), o.source, Date.now())
  return getBridgeOrigin(root)!
}

/**
 * The checkout as it stood when the bridge call arrived, read before the
 * turn ran. A later read diffs the checkout against it, so "nothing changed"
 * is a measured fact and not the agent's word. Any id of the chat.
 */
export function setBridgeOriginBaseline(
  conversationId: string,
  baseline: { tree: string; commit: string | null; at?: number },
): void {
  const db = getDb()
  db.prepare(
    'UPDATE bridge_origins SET baseline_tree = ?, baseline_commit = ?, baseline_at = ? WHERE conversation_id = ?',
  ).run(baseline.tree, baseline.commit, baseline.at ?? Date.now(), resolveRootThreadId(conversationId, db))
}

/** Records a stop's state on these chats (root ids). */
export function setBridgeOriginStopState(conversationIds: string[], state: BridgeOriginStopState): void {
  const db = getDb()
  const update = db.prepare('UPDATE bridge_origins SET stop_state = ? WHERE conversation_id = ?')
  db.transaction(() => {
    for (const id of conversationIds) update.run(state, id)
  })()
}

/**
 * Every chat with a bridge origin, as the chat lists mark it: root id to its
 * marker, with the measured-check summary read from the recorded runs. No
 * checkout is read here: a list must not spawn git for every row.
 */
export function bridgeOriginMarkers(): Map<string, BridgeOriginMarker> {
  const rows = getDb().prepare('SELECT conversation_id, stop_state FROM bridge_origins').all() as Array<
    Pick<OriginRow, 'conversation_id' | 'stop_state'>
  >
  if (rows.length === 0) return new Map()
  const checks = bridgeCheckSummaries()
  return new Map(
    rows.map((r) => {
      const summary = checks.get(r.conversation_id)
      return [r.conversation_id, { stop: r.stop_state, ...(summary ? { checks: summary } : {}) }]
    }),
  )
}

/** The chats bridge work started or reached on one machine. */
export function listBridgeOrigins(machineId: string): BridgeOrigin[] {
  return (getDb().prepare('SELECT * FROM bridge_origins WHERE machine_id = ?').all(machineId) as OriginRow[]).map(
    toOrigin,
  )
}

/** Any id of the chat, rotated or root. */
export function getBridgeOrigin(conversationId: string): BridgeOrigin | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM bridge_origins WHERE conversation_id = ?')
    .get(resolveRootThreadId(conversationId, db)) as OriginRow | undefined
  return row ? toOrigin(row) : null
}

// ─── Stop generation ────────────────────────────────────────────

export function readBridgeStopGeneration(): number {
  const row = getDb().prepare('SELECT generation FROM bridge_stop_generation WHERE id = 1').get() as
    | { generation: number }
    | undefined
  return row?.generation ?? 0
}

export interface BridgeStopRecord {
  generation: number
  killed: boolean
  /** A kill made on this desktop that the relay has not confirmed yet. */
  killPending: boolean
  lastResult: BridgeStopResult | null
}

type StopRow = { generation: number; killed: number; kill_pending: number; last_result: string | null }

export function readBridgeStopRecord(): BridgeStopRecord {
  const row = getDb()
    .prepare('SELECT generation, killed, kill_pending, last_result FROM bridge_stop_generation WHERE id = 1')
    .get() as StopRow | undefined
  if (!row) return { generation: 0, killed: false, killPending: false, lastResult: null }
  let lastResult: BridgeStopResult | null = null
  try {
    lastResult = row.last_result ? (JSON.parse(row.last_result) as BridgeStopResult) : null
  } catch (err) {
    // A row this build cannot read counts as no result: the next stop writes a new one.
    log.warn('the last bridge stop result is not valid JSON, starting over', err)
  }
  return { generation: row.generation, killed: row.killed === 1, killPending: row.kill_pending === 1, lastResult }
}

/**
 * Writes the stop state in one transaction. The generation never goes down;
 * `killed` and `killPending` are written as given, and `lastResult` only when
 * passed. Returns the stored record.
 */
export function writeBridgeStopRecord(next: {
  generation: number
  killed: boolean
  killPending: boolean
  lastResult?: BridgeStopResult
}): BridgeStopRecord {
  const db = getDb()
  return db
    .transaction((): BridgeStopRecord => {
      const current = readBridgeStopRecord()
      const result = next.lastResult ?? current.lastResult
      db.prepare(
        `INSERT INTO bridge_stop_generation (id, generation, killed, kill_pending, last_result, updated_at)
         VALUES (1, @generation, @killed, @killPending, @lastResult, @now)
         ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, killed = excluded.killed,
           kill_pending = excluded.kill_pending, last_result = excluded.last_result, updated_at = excluded.updated_at`,
      ).run({
        generation: Math.max(current.generation, next.generation),
        killed: next.killed ? 1 : 0,
        killPending: next.killPending ? 1 : 0,
        lastResult: result ? JSON.stringify(result) : null,
        now: Date.now(),
      })
      return readBridgeStopRecord()
    })
    .immediate()
}

/** At start: a stop that was still pending when the app ended cannot be accounted for. Returns those chats. */
export function markPendingBridgeStopsUnconfirmed(): string[] {
  const db = getDb()
  return db
    .transaction((): string[] => {
      const ids = (
        db.prepare(`SELECT conversation_id FROM bridge_origins WHERE stop_state = 'pending'`).all() as Array<{
          conversation_id: string
        }>
      ).map((r) => r.conversation_id)
      db.prepare(`UPDATE bridge_origins SET stop_state = 'unconfirmed' WHERE stop_state = 'pending'`).run()
      return ids
    })
    .immediate()
}

/**
 * Automatic resumes (limit auto-resume) skip a bridge chat while bridge work
 * is killed, or when a stop of all bridge work came after its last bridge call.
 */
export function bridgeAutoResumeBlocked(conversationId: string): boolean {
  const origin = getBridgeOrigin(conversationId)
  if (!origin) return false
  const stop = readBridgeStopRecord()
  return stop.killed || origin.stopGeneration < stop.generation
}

// ─── Measured check runs ────────────────────────────────────────
//
// One row per run of a configured check, keyed by the ROOT chat id, the
// definition hash and the source snapshot the run started from, so the same
// check never runs twice for the same code and a read never starts one. The
// row holds only what was observed: the command's hash, where it ran, the
// trees before and after, the real exit code or signal and a digest of the
// masked output. No log text and no agent claim is stored here.

/** `running`: started, no result yet. `cancelled`: a new turn or a source change ended it before a result. */
export const BRIDGE_CHECK_RUN_STATES = ['running', 'finished', 'cancelled', 'unavailable'] as const
export type BridgeCheckRunState = (typeof BRIDGE_CHECK_RUN_STATES)[number]

export interface BridgeCheckRun {
  runId: string
  conversationId: string
  projectId: string
  name: string
  definitionHash: string
  /** The folder the command ran in. Local only, never in a public answer. */
  cwd: string
  executionRootRevision: number | null
  /** The commit the run is bound to, or null when it measured a dirty tree. */
  commit: string | null
  treeBefore: string
  treeAfter: string | null
  dirty: boolean
  state: BridgeCheckRunState
  exitCode: number | null
  signal: string | null
  logDigest: string | null
  logBytes: number | null
  definitionChanged: boolean
  startedAt: number
  endedAt: number | null
}

type CheckRunRow = {
  run_id: string
  conversation_id: string
  project_id: string
  name: string
  definition_hash: string
  cwd: string
  execution_root_revision: number | null
  commit_sha: string | null
  tree_before: string
  tree_after: string | null
  dirty: number
  state: BridgeCheckRunState
  exit_code: number | null
  signal: string | null
  log_digest: string | null
  log_bytes: number | null
  definition_changed: number
  started_at: number
  ended_at: number | null
}

const toCheckRun = (r: CheckRunRow): BridgeCheckRun => ({
  runId: r.run_id,
  conversationId: r.conversation_id,
  projectId: r.project_id,
  name: r.name,
  definitionHash: r.definition_hash,
  cwd: r.cwd,
  executionRootRevision: r.execution_root_revision,
  commit: r.commit_sha,
  treeBefore: r.tree_before,
  treeAfter: r.tree_after,
  dirty: r.dirty === 1,
  state: r.state,
  exitCode: r.exit_code,
  signal: r.signal,
  logDigest: r.log_digest,
  logBytes: r.log_bytes,
  definitionChanged: r.definition_changed === 1,
  startedAt: r.started_at,
  endedAt: r.ended_at,
})

/** The hash a run is keyed by: the name, the program and the argument array. */
export function bridgeCheckDefinitionHash(def: BridgeCheckDefinition): string {
  return createHash('sha256').update(canonicalBridgeCheck(def)).digest('hex').slice(0, 32)
}

/**
 * Claims the one run for this chat, definition and source snapshot. Null when
 * a row is already there, so a second scheduler, a retry or a restart never
 * runs the same check twice over the same code.
 */
export function claimBridgeCheckRun(input: {
  conversationId: string
  projectId: string
  name: string
  definitionHash: string
  cwd: string
  executionRootRevision: number | null
  commit: string | null
  treeBefore: string
  dirty: boolean
  definitionChanged: boolean
  now?: number
}): BridgeCheckRun | null {
  const db = getDb()
  const runId = `bchk_${randomUUID()}`
  const changes = db
    .prepare(
      `INSERT OR IGNORE INTO bridge_check_runs (run_id, conversation_id, project_id, name, definition_hash, cwd,
         execution_root_revision, commit_sha, tree_before, dirty, state, definition_changed, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(
      runId,
      resolveRootThreadId(input.conversationId, db),
      input.projectId,
      input.name,
      input.definitionHash,
      input.cwd,
      input.executionRootRevision,
      input.commit,
      input.treeBefore,
      input.dirty ? 1 : 0,
      input.definitionChanged ? 1 : 0,
      input.now ?? Date.now(),
    ).changes
  return changes > 0 ? getBridgeCheckRun(runId) : null
}

export function getBridgeCheckRun(runId: string): BridgeCheckRun | null {
  const row = getDb().prepare('SELECT * FROM bridge_check_runs WHERE run_id = ?').get(runId) as CheckRunRow | undefined
  return row ? toCheckRun(row) : null
}

/** The result of a run that ended. A row already out of `running` keeps what it has. */
export function finishBridgeCheckRun(
  runId: string,
  result: {
    state: Exclude<BridgeCheckRunState, 'running'>
    exitCode?: number | null
    signal?: string | null
    logDigest?: string | null
    logBytes?: number | null
    treeAfter?: string | null
    now?: number
  },
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE bridge_check_runs SET state = ?, exit_code = ?, signal = ?, log_digest = ?, log_bytes = ?,
           tree_after = ?, ended_at = ? WHERE run_id = ? AND state = 'running'`,
      )
      .run(
        result.state,
        result.exitCode ?? null,
        result.signal ?? null,
        result.logDigest ?? null,
        result.logBytes ?? null,
        result.treeAfter ?? null,
        result.now ?? Date.now(),
        runId,
      ).changes > 0
  )
}

/** A new turn on the chat: every run still going is cancelled, so none reports a result it never had. */
export function cancelRunningBridgeCheckRuns(conversationId: string, now = Date.now()): number {
  const db = getDb()
  return db
    .prepare(
      `UPDATE bridge_check_runs SET state = 'cancelled', ended_at = ?
       WHERE conversation_id = ? AND state = 'running'`,
    )
    .run(now, resolveRootThreadId(conversationId, db)).changes
}

/** At start: a run the previous process was still going cannot be accounted for. */
export function cancelInterruptedBridgeCheckRuns(now = Date.now()): number {
  return getDb()
    .prepare(`UPDATE bridge_check_runs SET state = 'cancelled', ended_at = ? WHERE state = 'running'`)
    .run(now).changes
}

/**
 * The owner changed a project's checks: every recorded run there is flagged,
 * so a passing result never reads as the configured release check again.
 */
export function flagBridgeCheckDefinitionsChanged(projectId: string, keepHashes: readonly string[]): number {
  const db = getDb()
  const placeholders = keepHashes.map(() => '?').join(', ')
  const where = keepHashes.length > 0 ? ` AND definition_hash NOT IN (${placeholders})` : ''
  return db
    .prepare(`UPDATE bridge_check_runs SET definition_changed = 1 WHERE project_id = ?${where}`)
    .run(projectId, ...keepHashes).changes
}

/** The newest run per check name on one chat (any of its ids), newest first. */
export function listBridgeCheckRuns(conversationId: string): BridgeCheckRun[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM bridge_check_runs WHERE conversation_id = ? ORDER BY started_at DESC')
    .all(resolveRootThreadId(conversationId, db)) as CheckRunRow[]
  const newest = new Map<string, CheckRunRow>()
  for (const row of rows) if (!newest.has(row.name)) newest.set(row.name, row)
  return [...newest.values()].map(toCheckRun)
}

/**
 * Root chat id to the summary a chat list shows: the newest run per check
 * name, counted. A run that was cancelled, flagged or never finished is not
 * measured, and one unmeasured check makes the whole summary unmeasured.
 */
export function bridgeCheckSummaries(): Map<string, BridgeCheckSummary> {
  const rows = getDb().prepare('SELECT * FROM bridge_check_runs ORDER BY started_at DESC').all() as CheckRunRow[]
  const newest = new Map<string, CheckRunRow>()
  for (const row of rows) {
    const key = `${row.conversation_id}\u0000${row.name}`
    if (!newest.has(key)) newest.set(key, row)
  }
  const summaries = new Map<string, BridgeCheckSummary>()
  for (const row of newest.values()) {
    const summary = summaries.get(row.conversation_id) ?? { status: 'measured', passed: 0, failed: 0 }
    if (row.state === 'unavailable') summary.status = 'unavailable'
    else if (row.state !== 'finished')
      summary.status = summary.status === 'unavailable' ? summary.status : 'not_measured'
    else if (row.definition_changed === 1 || (row.tree_after !== null && row.tree_after !== row.tree_before))
      summary.status = summary.status === 'measured' ? 'stale' : summary.status
    else if (row.exit_code === 0) summary.passed += 1
    else summary.failed += 1
    summaries.set(row.conversation_id, summary)
  }
  return summaries
}

/** The newest run per check name across every bridge chat of one project, newest first. */
export function latestBridgeCheckRunsForProject(projectId: string): BridgeCheckRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM bridge_check_runs WHERE project_id = ? ORDER BY started_at DESC')
    .all(projectId) as CheckRunRow[]
  const newest = new Map<string, CheckRunRow>()
  for (const row of rows) if (!newest.has(row.name)) newest.set(row.name, row)
  return [...newest.values()].map(toCheckRun)
}
