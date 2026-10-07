import type { ChatMessage } from './types'

export const HISTORY_WINDOW_CAPABILITY = 'history_window_v1'
export interface HistoryWindowRequest {
  limit?: number
  beforeId?: string
}

/** Options of `app:load-session-by-id`. `imageRefs` needs `history_image_refs_v1`. */
export interface HistoryLoadOptions extends HistoryWindowRequest {
  window?: boolean
  imageRefs?: boolean
}

/** Stable message ids survive transcript growth between older-page requests. */
export function historyWindow(messages: ChatMessage[], request: HistoryWindowRequest) {
  const requestedLimit = request.limit ?? 200
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 200
  const cursor = request.beforeId ? messages.findIndex((message) => message.id === request.beforeId) : messages.length
  const end = cursor < 0 ? messages.length : cursor
  const start = Math.max(0, end - limit)
  return {
    messages: messages.slice(start, end),
    total: messages.length,
    truncated: start > 0,
    nextBeforeId: start > 0 ? messages[start].id : null,
    cursorReset: cursor < 0,
  }
}

export function shouldLoadPhoneHistory(historyLoaded: boolean, gap: boolean): boolean {
  return !historyLoaded || gap
}
