import Database from 'better-sqlite3'
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
import { resolveRootThreadId } from './conversations'

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
}

// ─── hub_parents ────────────────────────────────────────────────

export interface HubParentRow {
  parentId: string
  held: boolean
  heldReason: string | null
  heldAt: number | null
}

export function ensureHubParent(parentId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO hub_parents (parent_id, updated_at) VALUES (?, ?)')
    .run(resolveRootThreadId(parentId), Date.now())
}

export function getHubParent(parentId: string): HubParentRow | null {
  const row = getDb()
    .prepare('SELECT parent_id, held, held_reason, held_at FROM hub_parents WHERE parent_id = ?')
    .get(resolveRootThreadId(parentId)) as
    | { parent_id: string; held: number; held_reason: string | null; held_at: number | null }
    | undefined
  if (!row) return null
  return { parentId: row.parent_id, held: row.held === 1, heldReason: row.held_reason, heldAt: row.held_at }
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
})

export type NewHubChild = Pick<
  HubChildRow,
  'childId' | 'parentId' | 'batchId' | 'ordinal' | 'title' | 'brief' | 'location' | 'grantedMode' | 'depsMode'
> &
  Partial<Pick<HubChildRow, 'branch' | 'baseRef' | 'baseSha' | 'providerInstanceId' | 'requestedModel' | 'depsJson'>>

/** A new child in phase `starting`. Its `creation_id` is `<batch_id>-<ordinal>`. */
export function insertHubChild(c: NewHubChild): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO hub_children (child_id, parent_id, batch_id, ordinal, title, brief, location, creation_id, branch,
         base_ref, base_sha, provider_instance_id, requested_model, granted_mode, deps_mode, deps_json, phase,
         created_at, updated_at)
       VALUES (@childId, @parentId, @batchId, @ordinal, @title, @brief, @location, @creationId, @branch,
         @baseRef, @baseSha, @providerInstanceId, @requestedModel, @grantedMode, @depsMode, @depsJson, 'starting',
         @now, @now)`,
    )
    .run({
      ...c,
      branch: c.branch ?? null,
      baseRef: c.baseRef ?? null,
      baseSha: c.baseSha ?? null,
      providerInstanceId: c.providerInstanceId ?? null,
      requestedModel: c.requestedModel ?? null,
      depsJson: c.depsJson ?? null,
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
}

export function insertHubWake(w: {
  id: string
  parentId: string
  childId: string
  kind: HubWakeKind
  summary: string
  pointer: HubPointer | null
}): void {
  getDb()
    .prepare(
      `INSERT INTO hub_wakes (id, parent_id, child_id, kind, summary, pointer_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      w.id,
      resolveRootThreadId(w.parentId),
      resolveRootThreadId(w.childId),
      w.kind,
      w.summary,
      w.pointer ? JSON.stringify(w.pointer) : null,
      Date.now(),
    )
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
})

/** Each child's newest wake, delivered or not, keyed by child id. */
export function lastHubWakes(parentId: string): Map<string, { kind: HubWakeKind; summary: string }> {
  const rows = getDb()
    .prepare('SELECT child_id, kind, summary FROM hub_wakes WHERE parent_id = ? ORDER BY created_at, id')
    .all(resolveRootThreadId(parentId)) as Array<Pick<WakeDbRow, 'child_id' | 'kind' | 'summary'>>
  return new Map(rows.map((r) => [r.child_id, { kind: r.kind, summary: r.summary }]))
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

/** Every child in `phase`, across parents: startup recovery and the resource sampler. */
export function listHubChildrenInPhase(phase: HubChildPhase): HubChildRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM hub_children WHERE phase = ? ORDER BY created_at, ordinal')
    .all(phase) as ChildDbRow[]
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
  const r = getDb()
    .prepare('SELECT * FROM hub_wakes WHERE child_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(resolveRootThreadId(childId)) as WakeDbRow | undefined
  return r ? toWake(r) : null
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
