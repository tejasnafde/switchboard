/**
 * Lightweight pub/sub for session lifecycle events (rename, etc).
 * Used to keep Sidebar's local projects state in sync with ChatPanel
 * edits and vice versa — without hoisting state or pulling in a store.
 */

type RenameListener = (sessionId: string, title: string) => void

const renameListeners = new Set<RenameListener>()

export function onSessionRename(cb: RenameListener): () => void {
  renameListeners.add(cb)
  return () => renameListeners.delete(cb)
}

export function emitSessionRename(sessionId: string, title: string): void {
  for (const listener of renameListeners) {
    try { listener(sessionId, title) } catch { /* ignore */ }
  }
}

// ─── Session created ──────────────────────────────────────────────

export interface NewSession {
  id: string
  projectPath: string
  title: string
  startedAt: number
  source: 'switchboard' | 'claude-code' | 'codex'
}

type CreatedListener = (session: NewSession) => void

const createdListeners = new Set<CreatedListener>()

export function onSessionCreated(cb: CreatedListener): () => void {
  createdListeners.add(cb)
  return () => createdListeners.delete(cb)
}

export function emitSessionCreated(session: NewSession): void {
  for (const listener of createdListeners) {
    try { listener(session) } catch { /* ignore */ }
  }
}
