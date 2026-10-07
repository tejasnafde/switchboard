import type { ChatMessage } from '@shared/types'
import type { HistoryLoadOptions } from '@shared/phone-history-window'
import { useAgentStore } from '../stores/agent-store'
import { createRendererLogger } from '../logger'
import { perfSpan } from '../perf'
import { DESKTOP_HISTORY_WINDOW, olderThan } from './history-window'

const log = createRendererLogger('chat:history')

/** The desktop opens a chat with its newest window, images by reference.
 * A backend without `history_window_v1` / `history_image_refs_v1` ignores
 * these and answers the full history with data URLs, which renders as before. */
export const NEWEST_HISTORY_WINDOW: HistoryLoadOptions = { window: true, limit: DESKTOP_HISTORY_WINDOW, imageRefs: true }

interface HistoryResponse {
  messages?: ChatMessage[]
  nextBeforeId?: string | null
  cursorReset?: boolean
}

const inFlight = new Map<string, Promise<void>>()

function cursorOf(sessionId: string): string | null {
  return useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.olderHistoryCursor ?? null
}

function once(key: string, run: () => Promise<void>): Promise<void> {
  const running = inFlight.get(key)
  if (running) return running
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
        // The oldest shown row is gone from the backend's history; a fresh
        // tail would not line up in front of it, so stop paging here.
        log.warn('older history cursor no longer found', { sessionId })
        useAgentStore.getState().prependOlderMessages(sessionId, cursor, [], null)
        span.end({ outcome: 'cursor-reset' })
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

/** Load every row older than the shown window, for search, export and handoff. */
export function ensureFullHistory(sessionId: string): Promise<void> {
  return once(`full:${sessionId}`, async () => {
    const cursor = cursorOf(sessionId)
    if (!cursor) return
    const span = perfSpan('chat.load-full', { thread: sessionId })
    try {
      const resp = await window.api.app.loadSessionById(sessionId, { imageRefs: true }) as HistoryResponse
      // An older window may have landed meanwhile; cut at the row shown now.
      const current = cursorOf(sessionId)
      if (!current) {
        span.end({ outcome: 'stale' })
        return
      }
      const older = olderThan(resp?.messages ?? [], current)
      if (!older) {
        log.warn('full history does not hold the oldest shown row', { sessionId })
        span.end({ outcome: 'cursor-missing' })
        return
      }
      useAgentStore.getState().prependOlderMessages(sessionId, current, older, null)
      span.end({ outcome: 'loaded', messages: older.length })
    } catch (err) {
      span.end({ outcome: 'error' })
      log.warn('full history load failed', { sessionId, err })
    }
  })
}
