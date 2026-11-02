import Database from 'better-sqlite3'
import { HTML_LIVE_STILL_VERSION, isCurrentHtmlLiveStill, type HtmlLiveState } from '@shared/html-live'
import { getDb } from './database'

// ─── Inline live pages: still image and saved file, by source hash ──────

/** Rows kept; the oldest go first. A still image is at most a few MB. */
const MAX_ROWS = 300

export function ensureHtmlLivePagesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS html_live_pages (
      key        TEXT PRIMARY KEY,
      image      TEXT,
      image_version INTEGER,
      saved_path TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_html_live_pages_updated ON html_live_pages(updated_at DESC);
  `)
  // A row from before the version has NULL here: its still is ignored and overwritten, never deleted.
  const cols = db.prepare('PRAGMA table_info(html_live_pages)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'image_version'))
    db.exec('ALTER TABLE html_live_pages ADD COLUMN image_version INTEGER')
}

export function getHtmlLivePage(key: string): HtmlLiveState {
  const row = getDb().prepare('SELECT image, image_version, saved_path FROM html_live_pages WHERE key = ?').get(key) as
    | { image: string | null; image_version: number | null; saved_path: string | null }
    | undefined
  const image = row?.image && isCurrentHtmlLiveStill(row.image_version) ? row.image : null
  return { image, savedPath: row?.saved_path ?? null }
}

export function updateHtmlLivePage(key: string, patch: { image?: string; savedPath?: string }): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO html_live_pages (key, image, image_version, saved_path, updated_at)
       VALUES (@key, @image, @imageVersion, @savedPath, @now)
       ON CONFLICT(key) DO UPDATE SET
         image = COALESCE(@image, image),
         image_version = COALESCE(@imageVersion, image_version),
         saved_path = COALESCE(@savedPath, saved_path),
         updated_at = @now`,
    ).run({
      key,
      image: patch.image ?? null,
      imageVersion: patch.image ? HTML_LIVE_STILL_VERSION : null,
      savedPath: patch.savedPath ?? null,
      now: Date.now(),
    })
    db.prepare(
      'DELETE FROM html_live_pages WHERE key NOT IN (SELECT key FROM html_live_pages ORDER BY updated_at DESC LIMIT ?)',
    ).run(MAX_ROWS)
  })()
}
