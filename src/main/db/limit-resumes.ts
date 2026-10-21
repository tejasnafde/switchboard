import Database from 'better-sqlite3'
import type { LimitDisarmReason, LimitResumeRowState, LimitResumeRowView } from '@shared/limit-resume'
import { getDb } from './database'
import { resolveRootThreadId } from './conversations'

// ─── Auto-resume after a usage limit: one row per conversation ──
//
// Keyed by the ROOT conversation id (`resolveRootThreadId`).

export function ensureLimitResumesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS limit_resumes (
      conversation_id      TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      limited_turn_id      TEXT NOT NULL,
      reset_at             INTEGER NOT NULL,
      state                TEXT NOT NULL,
      request_id           TEXT NOT NULL,
      streak               INTEGER NOT NULL DEFAULT 0,
      last_fired_at        INTEGER,
      disarm_reason        TEXT,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_limit_resumes_state ON limit_resumes(state, reset_at);
  `)
}

export interface LimitResumeRow extends LimitResumeRowView {
  conversationId: string
  lastFiredAt: number | null
  disarmReason: LimitDisarmReason | null
  updatedAt: number
}

type DbRow = {
  conversation_id: string
  provider_instance_id: string
  limited_turn_id: string
  reset_at: number
  state: LimitResumeRowState
  request_id: string
  streak: number
  last_fired_at: number | null
  disarm_reason: LimitDisarmReason | null
  updated_at: number
}

const toRow = (r: DbRow): LimitResumeRow => ({
  conversationId: r.conversation_id,
  providerInstanceId: r.provider_instance_id,
  limitedTurnId: r.limited_turn_id,
  resetAt: r.reset_at,
  state: r.state,
  requestId: r.request_id,
  streak: r.streak,
  lastFiredAt: r.last_fired_at,
  disarmReason: r.disarm_reason,
  updatedAt: r.updated_at,
})

export function getLimitResume(conversationId: string): LimitResumeRow | null {
  const row = getDb()
    .prepare('SELECT * FROM limit_resumes WHERE conversation_id = ?')
    .get(resolveRootThreadId(conversationId)) as DbRow | undefined
  return row ? toRow(row) : null
}

/**
 * Arms the row for a limited turn. `requestId` must be new on every arm, so a
 * fire made for an earlier arm never runs. The streak carries over.
 */
export function armLimitResume(a: {
  conversationId: string
  providerInstanceId: string
  limitedTurnId: string
  resetAt: number
  requestId: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO limit_resumes (conversation_id, provider_instance_id, limited_turn_id, reset_at, state, request_id, updated_at)
       VALUES (@id, @instance, @turn, @resetAt, 'armed', @requestId, @now)
       ON CONFLICT(conversation_id) DO UPDATE SET provider_instance_id = @instance, limited_turn_id = @turn,
         reset_at = @resetAt, state = 'armed', request_id = @requestId, disarm_reason = NULL, updated_at = @now`,
    )
    .run({
      id: resolveRootThreadId(a.conversationId),
      instance: a.providerInstanceId,
      turn: a.limitedTurnId,
      resetAt: a.resetAt,
      requestId: a.requestId,
      now: Date.now(),
    })
}

/** Disarms an armed row. False when there was nothing armed. */
export function disarmLimitResume(conversationId: string, reason: LimitDisarmReason): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE limit_resumes SET state = 'disarmed', disarm_reason = ?, updated_at = ? WHERE conversation_id = ? AND state = 'armed'",
      )
      .run(reason, Date.now(), resolveRootThreadId(conversationId)).changes > 0
  )
}

/**
 * Marks the arm `requestId` fired. False when the row moved on (disarmed, or
 * re-armed with another request), so the caller must not send the resume.
 */
export function markLimitResumeFired(conversationId: string, requestId: string, at: number): boolean {
  return (
    getDb()
      .prepare(
        "UPDATE limit_resumes SET state = 'fired', last_fired_at = ?, updated_at = ? WHERE conversation_id = ? AND state = 'armed' AND request_id = ?",
      )
      .run(at, Date.now(), resolveRootThreadId(conversationId), requestId).changes > 0
  )
}

/** Records the streak after a resumed turn; at the cap the row gives up, and a turn that runs clears a give-up. */
export function setLimitResumeStreak(conversationId: string, streak: number, gaveUp: boolean): void {
  getDb()
    .prepare(
      `UPDATE limit_resumes SET streak = @streak, updated_at = @now,
         state = CASE WHEN @gaveUp THEN 'gave_up' WHEN @streak = 0 AND state = 'gave_up' THEN 'fired' ELSE state END
       WHERE conversation_id = @id`,
    )
    .run({ streak, gaveUp: gaveUp ? 1 : 0, now: Date.now(), id: resolveRootThreadId(conversationId) })
}

/** Every armed row, soonest reset first: the timers to rebuild at startup. */
export function listArmedLimitResumes(): LimitResumeRow[] {
  const rows = getDb().prepare("SELECT * FROM limit_resumes WHERE state = 'armed' ORDER BY reset_at").all() as DbRow[]
  return rows.map(toRow)
}
