/**
 * Live sidebar activity ordering. The sidebar sorts + labels sessions by
 * `startedAt`, which is loaded from `conversations.updated_at` at scan time
 * (so it is really "last activity", not creation). saveMessage bumps the DB
 * column, but the in-memory list only picked it up on reload - so the active
 * chat did not jump to the top with "now" until reopen. This bumps the
 * in-memory copy on send/turn so ordering is live.
 */
import type { Project } from '@shared/types'

/**
 * Bump one session's activity time and re-sort its project newest-first.
 * Returns the same array reference when the session is not present, so a
 * bump for a session in another window / already-gone thread does not force
 * a re-render.
 */
export function bumpSessionActivity(projects: Project[], sessionId: string, timestamp: number): Project[] {
  let found = false
  const next = projects.map((p) => {
    if (!p.sessions.some((s) => s.id === sessionId)) return p
    found = true
    const sessions = p.sessions
      .map((s) => (s.id === sessionId ? { ...s, startedAt: timestamp } : s))
      .sort((a, b) => b.startedAt - a.startedAt)
    return { ...p, sessions }
  })
  return found ? next : projects
}
