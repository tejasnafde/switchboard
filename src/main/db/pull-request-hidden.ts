import Database from 'better-sqlite3'
import { prKey, repoKey, type PrRef, type RepoRef } from '@shared/pull-requests'
import { getDb } from './database'

// ─── Pull requests hidden from Reviews ──────────────────────────
//
// Local only: nothing reaches the host. Keyed by `prKey` (already lowercased).
// `hiddenComesBack` (shared/pull-request-groups.ts) decides when a row is
// cleared again.
//
// `pull_request_hidden_repos` holds repositories the user hid from Reviews
// (keyed by `repoKey`); the service does not read them at all. They stay
// hidden until the user shows them again.

export function ensurePullRequestHiddenSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_request_hidden (
      pr_key    TEXT PRIMARY KEY,
      hidden_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_request_hidden_repos (
      repo_key  TEXT PRIMARY KEY,
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

export function hidePullRequestRepos(repos: readonly RepoRef[], now = Date.now()): void {
  const db = getDb()
  const put = db.prepare('INSERT OR REPLACE INTO pull_request_hidden_repos (repo_key, hidden_at) VALUES (?, ?)')
  db.transaction(() => { for (const repo of repos) put.run(repoKey(repo), now) })()
}

export function unhidePullRequestRepos(repos: readonly RepoRef[]): void {
  const db = getDb()
  const del = db.prepare('DELETE FROM pull_request_hidden_repos WHERE repo_key = ?')
  db.transaction(() => { for (const repo of repos) del.run(repoKey(repo)) })()
}

/** `repoKey`s hidden from Reviews. */
export function listHiddenPullRequestRepos(): Set<string> {
  const rows = getDb().prepare('SELECT repo_key FROM pull_request_hidden_repos').all() as Array<{ repo_key: string }>
  return new Set(rows.map((r) => r.repo_key))
}
