import type { ChatMessage } from './types'

export const HISTORY_WINDOW_CAPABILITY = 'history_window_v1'
export interface HistoryWindowRequest {
  limit?: number
  beforeId?: string
}

/** Options of `app:load-session-by-id`. `imageRefs` needs `history_image_refs_v1`,
 *  `toolPreviews` needs `history_tool_previews_v1`. */
export interface HistoryLoadOptions extends HistoryWindowRequest {
  window?: boolean
  imageRefs?: boolean
  toolPreviews?: boolean
}

/** Rows per window: the requested count, 1 to 200, 200 when absent or invalid. */
export function historyWindowLimit(requested = 200): number {
  return Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.min(200, Math.floor(requested))) : 200
}

/** Stable message ids survive transcript growth between older-page requests. */
export function historyWindow(messages: ChatMessage[], request: HistoryWindowRequest) {
  const limit = historyWindowLimit(request.limit)
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
