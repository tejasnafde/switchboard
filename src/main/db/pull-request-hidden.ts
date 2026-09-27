import Database from 'better-sqlite3'
import { prKey, type PrRef } from '@shared/pull-requests'
import { getDb } from './database'

// ─── Pull requests hidden from Reviews ──────────────────────────
//
// Local only: nothing reaches the host. Keyed by `prKey` (already lowercased).
// `hiddenComesBack` (shared/pull-request-groups.ts) decides when a row is
// cleared again.

export function ensurePullRequestHiddenSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_request_hidden (
      pr_key    TEXT PRIMARY KEY,
      hidden_at INTEGER NOT NULL
    );
  `)
}

export function hidePullRequest(ref: PrRef, now = Date.now()): void {
  getDb().prepare('INSERT OR REPLACE INTO pull_request_hidden (pr_key, hidden_at) VALUES (?, ?)').run(prKey(ref), now)
}

export function unhidePullRequest(ref: PrRef): void {
  unhidePullRequestKeys([prKey(ref)])
}

export function unhidePullRequestKeys(keys: readonly string[]): void {
  const del = getDb().prepare('DELETE FROM pull_request_hidden WHERE pr_key = ?')
  for (const key of keys) del.run(key)
}

/** `prKey` -> when it was hidden. */
export function listHiddenPullRequests(): Map<string, number> {
  const rows = getDb().prepare('SELECT pr_key, hidden_at FROM pull_request_hidden').all() as Array<{ pr_key: string; hidden_at: number }>
  return new Map(rows.map((r) => [r.pr_key, r.hidden_at]))
}
