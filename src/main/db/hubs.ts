import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  HUB_OUTBOX_SUMMARY_MAX,
  HUB_OUTBOX_TOOL_CALL_ID_MAX,
  parseHubOutboxItem,
  type HubOutboxItem,
  type HubOutboxMessage,
} from '@shared/hub-remote'
import {
  parseHubPointer,
  type HubBatchStatus,
  type HubChildLocation,
  type HubChildPhase,
  type HubDepsMode,
  type HubPointer,
  type HubWakeKind,
} from '@shared/hub'
import type { RuntimeMode } from '@shared/provider-events'
import { getDb } from './database'
import { createMainLogger } from '../logger'
import { resolveRootThreadId } from './conversations'

const log = createMainLogger('db:hubs')

// ─── Child chats: parents, batches, children, wakes ─────────────
//
// Every conversation id is stored and looked up as its ROOT id
// (`resolveRootThreadId`): a Claude session id rotates after its first turn.

export function ensureHubSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_parents (
      parent_id   TEXT PRIMARY KEY,
      held        INTEGER NOT NULL DEFAULT 0,
      held_reason TEXT,
      held_at     INTEGER,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_batches (
      batch_id        TEXT PRIMARY KEY,
      parent_id       TEXT NOT NULL,
      card_request_id TEXT,
      status          TEXT NOT NULL,
      plan_json       TEXT NOT NULL,
      plan_digest     TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hub_batches_parent ON hub_batches(parent_id, plan_digest);
    CREATE TABLE IF NOT EXISTS hub_children (
      child_id                  TEXT PRIMARY KEY,
      parent_id                 TEXT NOT NULL,
      batch_id                  TEXT NOT NULL,
      ordinal                   INTEGER NOT NULL,
      title                     TEXT NOT NULL,
      brief                     TEXT NOT NULL,
      location                  TEXT NOT NULL,
      creation_id               TEXT,
      branch                    TEXT,
      base_ref                  TEXT,
      base_sha                  TEXT,
      provider_instance_id      TEXT,
      requested_model           TEXT,
      granted_mode              TEXT NOT NULL,
      deps_mode                 TEXT NOT NULL,
      deps_json                 TEXT,
      phase                     TEXT NOT NULL,
      moved_after_limit_turn_id TEXT,
      settled_at                INTEGER,
      settle_json               TEXT,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL,
      UNIQUE (batch_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_hub_children_parent ON hub_children(parent_id, phase);
    CREATE TABLE IF NOT EXISTS hub_wakes (
      id                 TEXT PRIMARY KEY,
      parent_id          TEXT NOT NULL,
      child_id           TEXT NOT NULL,
      kind               TEXT NOT NULL,
      summary            TEXT NOT NULL,
      pointer_json       TEXT,
      created_at         INTEGER NOT NULL,
      delivered_revision INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hub_wakes_parent ON hub_wakes(parent_id, delivered_revision);
  `)
  // Children on other machines (additive): a parent stub here names the hub
  // that owns it; a desktop child row names the machine it runs on.
  const columns = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!columns('hub_parents').has('remote_hub')) db.exec('ALTER TABLE hub_parents ADD COLUMN remote_hub TEXT')
  if (!columns('hub_children').has('machine_id')) db.exec('ALTER TABLE hub_children ADD COLUMN machine_id TEXT')
  // A desktop wake imported from a child on another machine names that machine.
  if (!columns('hub_wakes').has('machine_id')) db.exec('ALTER TABLE hub_wakes ADD COLUMN machine_id TEXT')
  // When the child ran again, so the wake stopped being its current news.
  if (!columns('hub_wakes').has('stale_at')) db.exec('ALTER TABLE hub_wakes ADD COLUMN stale_at INTEGER')
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_outbox (
      id           TEXT PRIMARY KEY,
      child_id     TEXT NOT NULL,
      parent_id    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      acked_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hub_outbox_order ON hub_outbox(created_at, id);
    CREATE TABLE IF NOT EXISTS hub_remote_imports (
      machine_id  TEXT NOT NULL,
      remote_id   TEXT NOT NULL,
      kind        TEXT,
      child_id    TEXT,
      outcome     TEXT NOT NULL,
      reason      TEXT,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (machine_id, remote_id)
    );
    CREATE TABLE IF NOT EXISTS hub_remote_pending (
      machine_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      parent_id    TEXT NOT NULL,
      payload_json TEXT,
      created_at   INTEGER NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (machine_id, kind, target_id)
    );
  `)
  moveStubWakesToOutbox(db)
}

/**
 * Wakes stored for a parent stub before the outbox existed go into the
 * outbox once (same id with an `ho_` prefix, so a second run adds nothing),
 * without the transcript path, which names this machine's files.
 */
function moveStubWakesToOutbox(db: Database.Database): void {
  db.transaction(() => {
    const moved = db
      .prepare(
        `INSERT OR IGNORE INTO hub_outbox (id, child_id, parent_id, kind, payload_json, created_at)
         SELECT 'ho_' || w.id, w.child_id, w.parent_id, 'wake',
           json_object(
             'kind', w.kind,
             'summary', substr(w.summary, 1, ${HUB_OUTBOX_SUMMARY_MAX}),
             'pointer', CASE WHEN json_valid(w.pointer_json) THEN
               CASE WHEN json_type(w.pointer_json, '$.at') IN ('integer', 'real') THEN
                 CASE WHEN json_type(w.pointer_json, '$.toolCallId') = 'text'
                   AND length(json_extract(w.pointer_json, '$.toolCallId')) <= ${HUB_OUTBOX_TOOL_CALL_ID_MAX}
                 THEN json_object('at', json_extract(w.pointer_json, '$.at'),
                                  'toolCallId', json_extract(w.pointer_json, '$.toolCallId'))
                 ELSE json_object('at', json_extract(w.pointer_json, '$.at'))
                 END
               END
             END,
             'childPhase', COALESCE(c.phase, 'open')),
           w.created_at
         FROM hub_wakes w
         JOIN hub_parents p ON p.parent_id = w.parent_id
         LEFT JOIN hub_children c ON c.child_id = w.child_id
         WHERE p.remote_hub IS NOT NULL AND w.delivered_revision IS NULL`,
      )
      .run().changes
    if (moved === 0) return
    db.prepare(
      `DELETE FROM hub_wakes WHERE delivered_revision IS NULL
         AND parent_id IN (SELECT parent_id FROM hub_parents WHERE remote_hub IS NOT NULL)`,
    ).run()
  })()
}

/** This backend's id as a hub to other machines, minted once. */
export function hubInstallId(): string {
  const db = getDb()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'hub.installId'").get() as
    | { value: string }
    | undefined
  if (row?.value) return row.value
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('hub.installId', ?)").run(`hub-${randomUUID()}`)
  return (db.prepare("SELECT value FROM settings WHERE key = 'hub.installId'").get() as { value: string }).value
}

let rowSeq = 0

/**
 * A wake or outbox id that sorts in the order this process made them, within
 * one millisecond too: lists order by (created_at, id).
 */
export function newHubRowId(prefix: 'hw' | 'ho'): string {
  rowSeq = (rowSeq + 1) % 1_000_000
  return `${prefix}_${Date.now()}_${String(rowSeq).padStart(6, '0')}${randomUUID().slice(0, 4)}`
}

// ─── hub_parents ────────────────────────────────────────────────

export interface HubParentRow {
  parentId: string
  held: boolean
  heldReason: string | null
  heldAt: number | null
  /** A parent stub: the parent runs on the hub with this install id, not here. Null for a parent here. */
  remoteHub: string | null
}

export function ensureHubParent(parentId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO hub_parents (parent_id, updated_at) VALUES (?, ?)')
    .run(resolveRootThreadId(parentId), Date.now())
}

export function getHubParent(parentId: string): HubParentRow | null {
  const row = getDb()
    .prepare('SELECT parent_id, held, held_reason, held_at, remote_hub FROM hub_parents WHERE parent_id = ?')
    .get(resolveRootThreadId(parentId)) as
    | { parent_id: string; held: number; held_reason: string | null; held_at: number | null; remote_hub: string | null }
    | undefined
  if (!row) return null
  return {
    parentId: row.parent_id,
    held: row.held === 1,
    heldReason: row.held_reason,
    heldAt: row.held_at,
    remoteHub: row.remote_hub,
  }
}

/**
 * The stub of a parent on another machine's hub, made once. False when the
 * id is already a parent here or a stub of another hub.
 */
export function claimHubParentStub(parentId: string, remoteHub: string): boolean {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO hub_parents (parent_id, remote_hub, updated_at) VALUES (?, ?, ?)').run(
    parentId,
    remoteHub,
    Date.now(),
  )
  const row = db.prepare('SELECT remote_hub FROM hub_parents WHERE parent_id = ?').get(parentId) as {
    remote_hub: string | null
  }
  return row.remote_hub === remoteHub
}

/** Open (starting or open) children here whose parent is a stub of another machine's hub. */
export function countOpenRemoteHubChildren(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM hub_children c JOIN hub_parents p ON p.parent_id = c.parent_id
       WHERE p.remote_hub IS NOT NULL AND c.phase IN ('starting', 'open')`,
    )
    .get() as { n: number }
  return row.n
}

/** Sets or lifts the hold; a parent with no row gets one. */
export function setHubParentHeld(parentId: string, held: boolean, reason: string | null = null): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO hub_parents (parent_id, held, held_reason, held_at, updated_at) VALUES (@id, @held, @reason, @heldAt, @now)
       ON CONFLICT(parent_id) DO UPDATE SET held = @held, held_reason = @reason, held_at = @heldAt, updated_at = @now`,
    )
    .run({
      id: resolveRootThreadId(parentId),
      held: held ? 1 : 0,
      reason: held ? reason : null,
      heldAt: held ? now : null,
      now,
    })
}

// ─── hub_batches ────────────────────────────────────────────────

export interface HubBatchRow {
  batchId: string
  parentId: string
  cardRequestId: string | null
  status: HubBatchStatus
  planJson: string
  planDigest: string
  createdAt: number
}

type BatchDbRow = {
  batch_id: string
  parent_id: string
  card_request_id: string | null
  status: HubBatchStatus
  plan_json: string
  plan_digest: string
  created_at: number
}

const toBatch = (r: BatchDbRow): HubBatchRow => ({
  batchId: r.batch_id,
  parentId: r.parent_id,
  cardRequestId: r.card_request_id,
  status: r.status,
  planJson: r.plan_json,
  planDigest: r.plan_digest,
  createdAt: r.created_at,
})

export function createHubBatch(b: {
  batchId: string
  parentId: string
  cardRequestId: string | null
  planJson: string
  planDigest: string
}): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO hub_batches (batch_id, parent_id, card_request_id, status, plan_json, plan_digest, created_at, updated_at)
       VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?)`,
    )
    .run(b.batchId, resolveRootThreadId(b.parentId), b.cardRequestId, b.planJson, b.planDigest, now, now)
}

export function getHubBatch(batchId: string): HubBatchRow | null {
  const row = getDb().prepare('SELECT * FROM hub_batches WHERE batch_id = ?').get(batchId) as BatchDbRow | undefined
  return row ? toBatch(row) : null
}

/** The open (proposed) batch with this plan: a repeated `start_children` returns its card. */
export function findProposedHubBatch(parentId: string, planDigest: string): HubBatchRow | null {
  const row = getDb()
    .prepare("SELECT * FROM hub_batches WHERE parent_id = ? AND plan_digest = ? AND status = 'proposed'")
    .get(resolveRootThreadId(parentId), planDigest) as BatchDbRow | undefined
  return row ? toBatch(row) : null
}

export function setHubBatchStatus(batchId: string, status: HubBatchStatus): void {
  getDb()
    .prepare('UPDATE hub_batches SET status = ?, updated_at = ? WHERE batch_id = ?')
    .run(status, Date.now(), batchId)
}

// ─── hub_children ───────────────────────────────────────────────

export interface HubChildRow {
  childId: string
  parentId: string
  batchId: string
  ordinal: number
  title: string
  brief: string
  location: HubChildLocation
  creationId: string | null
  branch: string | null
  baseRef: string | null
  baseSha: string | null
  providerInstanceId: string | null
  requestedModel: string | null
  grantedMode: RuntimeMode
  depsMode: HubDepsMode
  depsJson: string | null
  phase: HubChildPhase
  movedAfterLimitTurnId: string | null
  settledAt: number | null
  settleJson: string | null
  createdAt: number
  /** The machine it runs on, for a child of a parent here that runs on another machine. Null: this machine. */
  machineId: string | null
}

type ChildDbRow = {
  child_id: string
  parent_id: string
  batch_id: string
  ordinal: number
  title: string
  brief: string
  location: HubChildLocation
  creation_id: string | null
  branch: string | null
  base_ref: string | null
  base_sha: string | null
  provider_instance_id: string | null
  requested_model: string | null
  granted_mode: RuntimeMode
  deps_mode: HubDepsMode
  deps_json: string | null
  phase: HubChildPhase
  moved_after_limit_turn_id: string | null
  settled_at: number | null
  settle_json: string | null
  created_at: number
  machine_id: string | null
}

const toChild = (r: ChildDbRow): HubChildRow => ({
  childId: r.child_id,
  parentId: r.parent_id,
  batchId: r.batch_id,
  ordinal: r.ordinal,
  title: r.title,
  brief: r.brief,
  location: r.location,
  creationId: r.creation_id,
  branch: r.branch,
  baseRef: r.base_ref,
  baseSha: r.base_sha,
  providerInstanceId: r.provider_instance_id,
  requestedModel: r.requested_model,
  grantedMode: r.granted_mode,
  depsMode: r.deps_mode,
  depsJson: r.deps_json,
  phase: r.phase,
  movedAfterLimitTurnId: r.moved_after_limit_turn_id,
  settledAt: r.settled_at,
  settleJson: r.settle_json,
  createdAt: r.created_at,
  machineId: r.machine_id,
})

export type NewHubChild = Pick<
  HubChildRow,
  'childId' | 'parentId' | 'batchId' | 'ordinal' | 'title' | 'brief' | 'location' | 'grantedMode' | 'depsMode'
> &
  Partial<
    Pick<
      HubChildRow,
      'branch' | 'baseRef' | 'baseSha' | 'providerInstanceId' | 'requestedModel' | 'depsJson' | 'machineId'
    >
  >

/** A new child in phase `starting`. Its `creation_id` is `<batch_id>-<ordinal>`. */
export function insertHubChild(c: NewHubChild): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO hub_children (child_id, parent_id, batch_id, ordinal, title, brief, location, creation_id, branch,
         base_ref, base_sha, provider_instance_id, requested_model, granted_mode, deps_mode, deps_json, phase,
         machine_id, created_at, updated_at)
       VALUES (@childId, @parentId, @batchId, @ordinal, @title, @brief, @location, @creationId, @branch,
         @baseRef, @baseSha, @providerInstanceId, @requestedModel, @grantedMode, @depsMode, @depsJson, 'starting',
         @machineId, @now, @now)`,
    )
    .run({
      ...c,
      branch: c.branch ?? null,
      baseRef: c.baseRef ?? null,
      baseSha: c.baseSha ?? null,
      providerInstanceId: c.providerInstanceId ?? null,
      requestedModel: c.requestedModel ?? null,
      depsJson: c.depsJson ?? null,
      machineId: c.machineId ?? null,
      childId: resolveRootThreadId(c.childId),
      parentId: resolveRootThreadId(c.parentId),
      creationId: `${c.batchId}-${c.ordinal}`,
      now,
    })
}

export function getHubChild(childId: string): HubChildRow | null {
  const row = getDb().prepare('SELECT * FROM hub_children WHERE child_id = ?').get(resolveRootThreadId(childId)) as
    | ChildDbRow
    | undefined
  return row ? toChild(row) : null
}

/** The parent of an open child (phase `starting` or `open`), or null. One primary-key read. */
export function openChildParentId(childId: string): string | null {
  const row = getDb()
    .prepare("SELECT parent_id FROM hub_children WHERE child_id = ? AND phase IN ('starting', 'open')")
    .get(resolveRootThreadId(childId)) as { parent_id: string } | undefined
  return row?.parent_id ?? null
}

/** A parent's children in batch order; settled ones only when asked. */
export function listHubChildren(parentId: string, opts: { includeSettled?: boolean } = {}): HubChildRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM hub_children WHERE parent_id = ? ${opts.includeSettled ? '' : "AND phase != 'settled'"}
       ORDER BY created_at, ordinal`,
    )
    .all(resolveRootThreadId(parentId)) as ChildDbRow[]
  return rows.map(toChild)
}

export type HubChildPatch = Partial<
  Pick<
    HubChildRow,
    | 'phase'
    | 'branch'
    | 'baseSha'
    | 'providerInstanceId'
    | 'grantedMode'
    | 'depsMode'
    | 'depsJson'
    | 'movedAfterLimitTurnId'
    | 'settledAt'
    | 'settleJson'
  >
>

const CHILD_COLUMNS: Record<keyof HubChildPatch, string> = {
  phase: 'phase',
  branch: 'branch',
  baseSha: 'base_sha',
  providerInstanceId: 'provider_instance_id',
  grantedMode: 'granted_mode',
  depsMode: 'deps_mode',
  depsJson: 'deps_json',
  movedAfterLimitTurnId: 'moved_after_limit_turn_id',
  settledAt: 'settled_at',
  settleJson: 'settle_json',
}

export function updateHubChild(childId: string, patch: HubChildPatch): void {
  // better-sqlite3 cannot bind undefined, so an undefined field is left as it is.
  const keys = (Object.keys(patch) as Array<keyof HubChildPatch>).filter(
    (k) => k in CHILD_COLUMNS && patch[k] !== undefined,
  )
  if (keys.length === 0) return
  const sets = keys.map((k) => `${CHILD_COLUMNS[k]} = @${k}`).join(', ')
  getDb()
    .prepare(`UPDATE hub_children SET ${sets}, updated_at = @now WHERE child_id = @childId`)
    .run({
      ...Object.fromEntries(keys.map((k) => [k, patch[k]])),
      now: Date.now(),
      childId: resolveRootThreadId(childId),
    })
}

// ─── hub_wakes ──────────────────────────────────────────────────

export interface HubWakeRow {
  id: string
  parentId: string
  childId: string
  kind: HubWakeKind
  summary: string
  pointer: HubPointer | null
  createdAt: number
  deliveredRevision: number | null
  /** Imported from a child on this machine (`hub_children.machine_id`); null for a local child. */
  machineId: string | null
}

type WakeDbRow = {
  id: string
  parent_id: string
  child_id: string
  kind: HubWakeKind
  summary: string
  pointer_json: string | null
  created_at: number
  delivered_revision: number | null
  machine_id: string | null
}

/**
 * Stores a wake for its parent. For a parent stub (the parent runs on another
 * machine's hub) it becomes an outbox item for that hub instead, and the
 * answer says so: the caller tells the hub client (`hub-remote:outbox`).
 */
export function insertHubWake(w: {
  id: string
  parentId: string
  childId: string
  kind: HubWakeKind
  summary: string
  pointer: HubPointer | null
  machineId?: string | null
}): 'wake' | 'outbox' {
  const db = getDb()
  const parentId = resolveRootThreadId(w.parentId)
  const childId = resolveRootThreadId(w.childId)
  const stub = db.prepare('SELECT remote_hub FROM hub_parents WHERE parent_id = ?').get(parentId) as
    | { remote_hub: string | null }
    | undefined
  if (stub?.remote_hub) {
    const phase = db.prepare('SELECT phase FROM hub_children WHERE child_id = ?').get(childId) as
      | { phase: HubChildPhase }
      | undefined
    insertHubOutbox({
      id: newHubRowId('ho'),
      childId,
      parentId,
      kind: 'wake',
      payload: {
        kind: w.kind,
        summary: w.summary.slice(0, HUB_OUTBOX_SUMMARY_MAX),
        pointer: w.pointer
          ? {
              at: w.pointer.at,
              ...(w.pointer.toolCallId && w.pointer.toolCallId.length <= HUB_OUTBOX_TOOL_CALL_ID_MAX
                ? { toolCallId: w.pointer.toolCallId }
                : {}),
            }
          : null,
        childPhase: phase?.phase ?? 'open',
      },
    })
    return 'outbox'
  }
  db.prepare(
    `INSERT INTO hub_wakes (id, parent_id, child_id, kind, summary, pointer_json, created_at, machine_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    w.id,
    parentId,
    childId,
    w.kind,
    w.summary,
    w.pointer ? JSON.stringify(w.pointer) : null,
    Date.now(),
    w.machineId ?? null,
  )
  return 'wake'
}

/** A parent's undelivered wakes, oldest first. */
export function listPendingHubWakes(parentId: string): HubWakeRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM hub_wakes WHERE parent_id = ? AND delivered_revision IS NULL ORDER BY created_at, id')
    .all(resolveRootThreadId(parentId)) as WakeDbRow[]
  return rows.map(toWake)
}

const toWake = (r: WakeDbRow): HubWakeRow => ({
  id: r.id,
  parentId: r.parent_id,
  childId: r.child_id,
  kind: r.kind,
  summary: r.summary,
  pointer: parseHubPointer(r.pointer_json),
  createdAt: r.created_at,
  deliveredRevision: r.delivered_revision,
  machineId: r.machine_id ?? null,
})

/**
 * A child started a turn again, so the updates it sent before are old news:
 * they stay stored and are still delivered, but `lastHubWakes` stops showing
 * them. Returns how many stopped showing.
 */
export function markHubChildWakesStale(childId: string, at = Date.now()): number {
  return getDb()
    .prepare('UPDATE hub_wakes SET stale_at = ? WHERE child_id = ? AND stale_at IS NULL')
    .run(at, resolveRootThreadId(childId)).changes
}

/** Each child's newest current wake, delivered or not, keyed by child id; a parent stub's are in the outbox. */
export function lastHubWakes(parentId: string): Map<string, { kind: HubWakeKind; summary: string }> {
  const root = resolveRootThreadId(parentId)
  const rows = getDb()
    .prepare('SELECT * FROM hub_wakes WHERE parent_id = ? AND stale_at IS NULL ORDER BY created_at, id')
    .all(root) as WakeDbRow[]
  const all = [...rows.map(toWake), ...outboxWakes('parent_id', root)].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return new Map(all.map((w) => [w.childId, { kind: w.kind, summary: w.summary }]))
}

/** Outbox wakes as wake rows (a child of a parent stub here), oldest first. */
function outboxWakes(column: 'parent_id' | 'child_id', id: string): HubWakeRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, child_id, parent_id, kind, payload_json, created_at FROM hub_outbox
       WHERE ${column} = ? AND kind = 'wake' ORDER BY created_at, id`,
    )
    .all(id) as OutboxDbRow[]
  return rows.flatMap((r) => {
    const item = toOutboxItem(r)
    if (item?.kind !== 'wake') return []
    const p = item.wake.pointer
    return [
      {
        id: r.id,
        parentId: r.parent_id,
        childId: r.child_id,
        kind: item.wake.kind,
        summary: item.wake.summary,
        pointer: p ? { childId: r.child_id, at: p.at, ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}) } : null,
        createdAt: r.created_at,
        deliveredRevision: null,
        machineId: null,
      },
    ]
  })
}

/**
 * Marks wakes delivered by the parent turn `revision`; a wake already delivered
 * keeps its first revision. Pass `db` to join a transaction already open on it.
 */
export function markHubWakesDelivered(ids: readonly string[], revision: number, db = getDb()): number {
  const stmt = db.prepare('UPDATE hub_wakes SET delivered_revision = ? WHERE id = ? AND delivered_revision IS NULL')
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(revision, id).changes, 0))()
}

/** Every open child (phase `starting` or `open`), across parents: the session list's `hub` field. */
export function listOpenHubChildren(): Array<{ childId: string; parentId: string }> {
  const rows = getDb()
    .prepare("SELECT child_id, parent_id FROM hub_children WHERE phase IN ('starting', 'open')")
    .all() as Array<{ child_id: string; parent_id: string }>
  return rows.map((r) => ({ childId: r.child_id, parentId: r.parent_id }))
}

/**
 * Every child in `phase`, across parents: startup recovery, the reaper and the
 * resource sampler. Children that run on another machine are left out unless
 * asked for: nothing local acts on them.
 */
export function listHubChildrenInPhase(phase: HubChildPhase, opts: { includeRemote?: boolean } = {}): HubChildRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM hub_children WHERE phase = ? ${opts.includeRemote ? '' : 'AND machine_id IS NULL'}
       ORDER BY created_at, ordinal`,
    )
    .all(phase) as ChildDbRow[]
  return rows.map(toChild)
}

/** Open (starting or open) children of parents here that run on another machine. */
export function listOpenRemoteHubChildren(): HubChildRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM hub_children WHERE machine_id IS NOT NULL AND phase IN ('starting', 'open')")
    .all() as ChildDbRow[]
  return rows.map(toChild)
}

/** Parents with undelivered wakes: the wake scheduler's work at startup. */
export function listParentsWithPendingHubWakes(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT parent_id FROM hub_wakes WHERE delivered_revision IS NULL')
    .all() as Array<{ parent_id: string }>
  return rows.map((r) => r.parent_id)
}

/** A child's newest wake that points into its transcript: where `read_child` starts and what a gone transcript leaves. */
export function lastHubWakeOf(childId: string): HubWakeRow | null {
  const root = resolveRootThreadId(childId)
  const r = getDb()
    .prepare('SELECT * FROM hub_wakes WHERE child_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(root) as WakeDbRow | undefined
  const local = r ? toWake(r) : null
  // A child of a parent stub: its wakes are in the outbox.
  const outbox = outboxWakes('child_id', root).at(-1) ?? null
  if (!outbox) return local
  if (!local) return outbox
  return outbox.createdAt > local.createdAt || (outbox.createdAt === local.createdAt && outbox.id > local.id)
    ? outbox
    : local
}

/** Chats and cards other than the child's own thread that work in `worktreePath` (a fork of the child, or a chat opened there). */
export function otherWorktreeUsers(worktreePath: string, childId: string): number {
  const db = getDb()
  const root = resolveRootThreadId(childId)
  const chats = db
    .prepare('SELECT id FROM conversations WHERE worktree_path = @p OR project_path = @p')
    .all({ p: worktreePath }) as Array<{
    id: string
  }>
  const cards = db
    .prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE worktree_path = @p OR project_path = @p')
    .get({ p: worktreePath }) as {
    n: number
  }
  const project = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE path = ?').get(worktreePath) as { n: number }
  return chats.filter((c) => resolveRootThreadId(c.id) !== root).length + cards.n + project.n
}

// ─── hub_outbox (a child machine) ───────────────────────────────
//
// What a child here sends its parent stub waits here until the desktop that
// owns the stub (`hub_parents.remote_hub`) pulls and acks it.

function insertHubOutbox(item: {
  id: string
  childId: string
  parentId: string
  kind: 'wake' | 'message'
  payload: unknown
}): void {
  getDb()
    .prepare(
      `INSERT INTO hub_outbox (id, child_id, parent_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(item.id, item.childId, item.parentId, item.kind, JSON.stringify(item.payload), Date.now())
}

/** A child's message to its parent stub. Returns the item id. */
export function insertHubOutboxMessage(m: { childId: string; parentId: string } & HubOutboxMessage): string {
  const id = newHubRowId('ho')
  insertHubOutbox({
    id,
    childId: resolveRootThreadId(m.childId),
    parentId: resolveRootThreadId(m.parentId),
    kind: 'message',
    payload: { text: m.text, delivery: m.delivery },
  })
  return id
}

/** A child's messages its parent's hub has not acked yet. */
export function countUnackedHubOutboxMessages(childId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM hub_outbox WHERE child_id = ? AND kind = 'message' AND acked_at IS NULL")
    .get(resolveRootThreadId(childId)) as { n: number }
  return row.n
}

type OutboxDbRow = {
  id: string
  child_id: string
  parent_id: string
  kind: string
  payload_json: string
  created_at: number
}

/** A stored row as the item the desktop pulls, checked as the desktop checks it; null when it no longer parses. */
function toOutboxItem(r: OutboxDbRow): HubOutboxItem | null {
  let payload: unknown
  try {
    payload = JSON.parse(r.payload_json)
  } catch (err) {
    log.warn(`outbox row ${r.id} holds no JSON`, err)
    return null
  }
  return parseHubOutboxItem({
    id: r.id,
    childId: r.child_id,
    parentId: r.parent_id,
    createdAt: r.created_at,
    kind: r.kind,
    ...(r.kind === 'wake' ? { wake: payload } : { message: payload }),
  })
}

/**
 * Unacked items for parent stubs of the hub `remoteHub`, in (created_at, id)
 * order, after the item `after` when it is still here. A row that no longer
 * parses is skipped with its id, so the caller can ack it. `cursor` is the last
 * row read when the page was full, else null.
 */
export function listHubOutbox(
  remoteHub: string,
  opts: { after?: string; limit: number },
): { items: HubOutboxItem[]; malformed: string[]; cursor: string | null } {
  const db = getDb()
  const anchor = opts.after
    ? (db.prepare('SELECT created_at, id FROM hub_outbox WHERE id = ?').get(opts.after) as
        | { created_at: number; id: string }
        | undefined)
    : undefined
  const rows = db
    .prepare(
      `SELECT o.id, o.child_id, o.parent_id, o.kind, o.payload_json, o.created_at
       FROM hub_outbox o JOIN hub_parents p ON p.parent_id = o.parent_id
       WHERE p.remote_hub = @hub AND o.acked_at IS NULL
         AND (@at IS NULL OR o.created_at > @at OR (o.created_at = @at AND o.id > @id))
       ORDER BY o.created_at, o.id
       LIMIT @limit`,
    )
    .all({ hub: remoteHub, at: anchor?.created_at ?? null, id: anchor?.id ?? null, limit: opts.limit }) as OutboxDbRow[]
  const items: HubOutboxItem[] = []
  const malformed: string[] = []
  for (const r of rows) {
    const item = toOutboxItem(r)
    if (item) items.push(item)
    else malformed.push(r.id)
  }
  return { items, malformed, cursor: rows.length === opts.limit ? rows[rows.length - 1]!.id : null }
}

/** Marks items acked, only those for parent stubs of `remoteHub`; an acked item keeps its first time. */
export function ackHubOutbox(remoteHub: string, ids: readonly string[], now = Date.now()): number {
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE hub_outbox SET acked_at = ? WHERE id = ? AND acked_at IS NULL
       AND parent_id IN (SELECT parent_id FROM hub_parents WHERE remote_hub = ?)`,
  )
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(now, id, remoteHub).changes, 0))()
}

/** Deletes rows of the hub `remoteHub` that no longer parse; they can never be sent. */
export function dropHubOutbox(remoteHub: string, ids: readonly string[]): number {
  const db = getDb()
  const stmt = db.prepare(
    `DELETE FROM hub_outbox WHERE id = ?
       AND parent_id IN (SELECT parent_id FROM hub_parents WHERE remote_hub = ?)`,
  )
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(id, remoteHub).changes, 0))()
}

/** Deletes acked items older than `keepMs`. */
export function pruneHubOutbox(keepMs: number, now = Date.now()): number {
  return getDb()
    .prepare('DELETE FROM hub_outbox WHERE acked_at IS NOT NULL AND acked_at < ?')
    .run(now - keepMs).changes
}

// ─── hub_remote_imports (the desktop) ───────────────────────────
//
// One row per outbox item imported from a machine, so a pull after a lost ack
// imports nothing twice.

export type HubRemoteImportOutcome = 'imported' | 'delivering' | 'refused' | 'dropped'

export interface HubRemoteImportRow {
  machineId: string
  remoteId: string
  kind: string | null
  childId: string | null
  outcome: HubRemoteImportOutcome
  reason: string | null
  importedAt: number
}

export function getHubRemoteImport(machineId: string, remoteId: string): HubRemoteImportRow | null {
  const r = getDb()
    .prepare('SELECT * FROM hub_remote_imports WHERE machine_id = ? AND remote_id = ?')
    .get(machineId, remoteId) as
    | {
        machine_id: string
        remote_id: string
        kind: string | null
        child_id: string | null
        outcome: HubRemoteImportOutcome
        reason: string | null
        imported_at: number
      }
    | undefined
  if (!r) return null
  return {
    machineId: r.machine_id,
    remoteId: r.remote_id,
    kind: r.kind,
    childId: r.child_id,
    outcome: r.outcome,
    reason: r.reason,
    importedAt: r.imported_at,
  }
}

/** Records an import; false when that item was recorded before (nothing changes then). */
export function insertHubRemoteImport(i: {
  machineId: string
  remoteId: string
  kind: string | null
  childId: string | null
  outcome: HubRemoteImportOutcome
  reason?: string | null
}): boolean {
  return (
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO hub_remote_imports (machine_id, remote_id, kind, child_id, outcome, reason, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.machineId, i.remoteId, i.kind, i.childId, i.outcome, i.reason ?? null, Date.now()).changes === 1
  )
}

export function setHubRemoteImportOutcome(
  machineId: string,
  remoteId: string,
  outcome: HubRemoteImportOutcome,
  reason: string | null,
): void {
  getDb()
    .prepare('UPDATE hub_remote_imports SET outcome = ?, reason = ? WHERE machine_id = ? AND remote_id = ?')
    .run(outcome, reason, machineId, remoteId)
}

// ─── hub_remote_pending (desktop) ───────────────────────────────
//
// A Stop, a settle or a stop-all for a machine that is not connected waits
// here and is sent on that machine's next connect, before anything else.
// One row per (machine, kind, target): a second Stop of the same child is the
// same row. Survives a restart. `attempts` counts sends that failed with the
// machine connected (a timeout, a dropped socket), so the row is not tried forever.

export type HubRemotePendingKind = 'stop' | 'settle' | 'stop_all'

export interface HubRemotePendingRow {
  machineId: string
  kind: HubRemotePendingKind
  /** The child for `stop` and `settle`, the parent for `stop_all`. */
  targetId: string
  parentId: string
  /** `settle`: `{ parentHead }`; `stop`: `{ cascade: true }` for the parent's Stop. */
  payload: Record<string, unknown> | null
  createdAt: number
  attempts: number
}

export function addHubRemotePending(p: Omit<HubRemotePendingRow, 'createdAt' | 'attempts'>): void {
  getDb()
    .prepare(
      `INSERT INTO hub_remote_pending (machine_id, kind, target_id, parent_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, kind, target_id) DO UPDATE SET payload_json = excluded.payload_json`,
    )
    .run(p.machineId, p.kind, p.targetId, p.parentId, p.payload ? JSON.stringify(p.payload) : null, Date.now())
}

export function listHubRemotePending(machineId?: string): HubRemotePendingRow[] {
  const rows = (
    machineId === undefined
      ? getDb().prepare('SELECT * FROM hub_remote_pending ORDER BY created_at')
      : getDb().prepare('SELECT * FROM hub_remote_pending WHERE machine_id = ? ORDER BY created_at')
  ).all(...(machineId === undefined ? [] : [machineId])) as Array<{
    machine_id: string
    kind: string
    target_id: string
    parent_id: string
    payload_json: string | null
    created_at: number
    attempts: number
  }>
  return rows.flatMap((r) => {
    if (r.kind !== 'stop' && r.kind !== 'settle' && r.kind !== 'stop_all') return []
    let payload: Record<string, unknown> | null = null
    try {
      const parsed: unknown = r.payload_json ? JSON.parse(r.payload_json) : null
      payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch (err) {
      log.warn('a pending remote stop has a payload that does not parse', err)
    }
    return [
      {
        machineId: r.machine_id,
        kind: r.kind,
        targetId: r.target_id,
        parentId: r.parent_id,
        payload,
        createdAt: r.created_at,
        attempts: r.attempts,
      },
    ]
  })
}

export function deleteHubRemotePending(machineId: string, kind: HubRemotePendingKind, targetId: string): void {
  getDb()
    .prepare('DELETE FROM hub_remote_pending WHERE machine_id = ? AND kind = ? AND target_id = ?')
    .run(machineId, kind, targetId)
}

/** One more failed send of a pending row; the attempts now, or 0 when the row is gone. */
export function failHubRemotePending(machineId: string, kind: HubRemotePendingKind, targetId: string): number {
  const row = getDb()
    .prepare(
      'UPDATE hub_remote_pending SET attempts = attempts + 1 WHERE machine_id = ? AND kind = ? AND target_id = ? RETURNING attempts',
    )
    .get(machineId, kind, targetId) as { attempts: number } | undefined
  return row?.attempts ?? 0
}
