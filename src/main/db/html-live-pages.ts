import Database from 'better-sqlite3'
import type { HtmlLiveState } from '@shared/html-live'
import { getDb } from './database'

// ─── Inline live pages: still image and saved file, by source hash ──────

/** Rows kept; the oldest go first. A still image is at most a few MB. */
const MAX_ROWS = 300

export function ensureHtmlLivePagesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS html_live_pages (
      key        TEXT PRIMARY KEY,
      image      TEXT,
      saved_path TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_html_live_pages_updated ON html_live_pages(updated_at DESC);
  `)
}

export function getHtmlLivePage(key: string): HtmlLiveState {
  const row = getDb().prepare('SELECT image, saved_path FROM html_live_pages WHERE key = ?').get(key) as
    | { image: string | null; saved_path: string | null }
    | undefined
  return { image: row?.image ?? null, savedPath: row?.saved_path ?? null }
}

export function updateHtmlLivePage(key: string, patch: { image?: string; savedPath?: string }): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO html_live_pages (key, image, saved_path, updated_at) VALUES (@key, @image, @savedPath, @now)
       ON CONFLICT(key) DO UPDATE SET
         image = COALESCE(@image, image),
         saved_path = COALESCE(@savedPath, saved_path),
         updated_at = @now`,
    ).run({ key, image: patch.image ?? null, savedPath: patch.savedPath ?? null, now: Date.now() })
    db.prepare(
      'DELETE FROM html_live_pages WHERE key NOT IN (SELECT key FROM html_live_pages ORDER BY updated_at DESC LIMIT ?)',
    ).run(MAX_ROWS)
  })()
}
