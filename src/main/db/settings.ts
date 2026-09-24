import { getDb } from './database'

// ─── Settings CRUD ──────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run(key, value)
}

export function removeSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

// ─── Session Layout CRUD ───────────────────────────────────────

export interface StoredSessionLayout {
  layoutJson: string
  /** Name of the launch config this layout was hydrated from. */
  launchConfigName: string | null
}

export function saveSessionLayout(
  sessionId: string,
  layoutJson: string,
  launchConfigName?: string | null,
): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO session_layouts (session_id, layout_json, launch_config_name, updated_at) VALUES (?, ?, ?, ?)'
  ).run(sessionId, layoutJson, launchConfigName ?? null, Date.now())
}

export function getSessionLayout(sessionId: string): StoredSessionLayout | null {
  const row = getDb().prepare(
    'SELECT layout_json, launch_config_name FROM session_layouts WHERE session_id = ?'
  ).get(sessionId) as { layout_json: string; launch_config_name: string | null } | undefined
  if (!row) return null
  return { layoutJson: row.layout_json, launchConfigName: row.launch_config_name }
}

export function removeSessionLayout(sessionId: string): void {
  getDb().prepare('DELETE FROM session_layouts WHERE session_id = ?').run(sessionId)
}
