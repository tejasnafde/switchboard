import type { ChatMessage } from '@shared/types'
import type { HistoryLoadOptions } from '@shared/phone-history-window'
import { useAgentStore } from '../stores/agent-store'
import { createRendererLogger } from '../logger'
import { perfSpan } from '../perf'
import { DESKTOP_HISTORY_WINDOW, olderThan } from './history-window'

const log = createRendererLogger('chat:history')

/** The desktop opens a chat with its newest window, images by reference and
 * long tool calls as previews. A backend without `history_window_v1`,
 * `history_image_refs_v1` or `history_tool_previews_v1` ignores these and
 * answers in full, which renders as before. */
export const NEWEST_HISTORY_WINDOW: HistoryLoadOptions = { window: true, limit: DESKTOP_HISTORY_WINDOW, imageRefs: true, toolPreviews: true }

interface HistoryResponse {
  messages?: ChatMessage[]
  nextBeforeId?: string | null
  cursorReset?: boolean
}

const inFlight = new Map<string, Promise<unknown>>()

function cursorOf(sessionId: string): string | null {
  return useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.olderHistoryCursor ?? null
}

/** The store holds every row of the chat: it is there and has no older window left. */
function holdsAllRows(sessionId: string): boolean {
  const session = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
  return Boolean(session) && !session?.olderHistoryCursor
}

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running) return running as Promise<T>
  const next = run().finally(() => inFlight.delete(key))
  inFlight.set(key, next)
  return next
}

/** Load the window before the oldest shown row. No-op when all is loaded. */
export function loadOlderHistory(sessionId: string): Promise<void> {
  return once(`older:${sessionId}`, async () => {
    const cursor = cursorOf(sessionId)
    if (!cursor) return
    const span = perfSpan('chat.load-older', { thread: sessionId })
    try {
      const resp = await window.api.app.loadSessionById(sessionId, { ...NEWEST_HISTORY_WINDOW, beforeId: cursor }) as HistoryResponse
      if (resp?.cursorReset) {
        // The oldest shown row is gone from the backend's history, and the
        // answer is its newest window. Start over from that window (keeping
        // live rows) so paging continues from a row the backend still has.
        log.warn('older history cursor no longer found', { sessionId })
        const store = useAgentStore.getState()
        const newest = resp.messages ?? []
        const rebased = store.rebaseHistoryWindow(sessionId, cursor, newest, resp.nextBeforeId ?? null)
        // No shown row is in that window, so nothing lines up: stop paging.
        if (!rebased) store.prependOlderMessages(sessionId, cursor, [], null)
        span.end({ outcome: rebased ? 'cursor-reset' : 'cursor-reset-stopped', messages: newest.length })
        return
      }
      const older = resp?.messages ?? []
      const applied = useAgentStore.getState().prependOlderMessages(sessionId, cursor, older, resp?.nextBeforeId ?? null)
      span.end({ outcome: applied ? 'loaded' : 'stale', messages: older.length })
    } catch (err) {
      span.end({ outcome: 'error' })
      log.warn('older history load failed', { sessionId, err })
    }
  })
}

/**
 * Load every row older than the shown window, for search, export and handoff.
 * Resolves true only when the store then holds the whole chat, so a caller
 * that needs every row (a handoff preamble, a jump to an old row) can stop.
 */
export function ensureFullHistory(sessionId: string): Promise<boolean> {
  return once(`full:${sessionId}`, async () => {
    const cursor = cursorOf(sessionId)
    if (!cursor) return holdsAllRows(sessionId)
    const span = perfSpan('chat.load-full', { thread: sessionId })
    try {
      const resp = await window.api.app.loadSessionById(sessionId, { imageRefs: true, toolPreviews: true }) as HistoryResponse
      // An older window may have landed meanwhile; cut at the row shown now.
      const current = cursorOf(sessionId)
      if (!current) {
        span.end({ outcome: 'stale' })
        return holdsAllRows(sessionId)
      }
      const older = olderThan(resp?.messages ?? [], current)
      if (!older) {
        log.warn('full history does not hold the oldest shown row', { sessionId })
        span.end({ outcome: 'cursor-missing' })
        return false
      }
      const applied = useAgentStore.getState().prependOlderMessages(sessionId, current, older, null)
      span.end({ outcome: applied ? 'loaded' : 'stale', messages: older.length })
      return holdsAllRows(sessionId)
    } catch (err) {
      span.end({ outcome: 'error' })
      log.warn('full history load failed', { sessionId, err })
      return holdsAllRows(sessionId)
    }
  })
}
