import type { ChatMessage } from '@shared/types'

/** Rows per desktop history window: one window of a long chat is ~130 KB. */
export const DESKTOP_HISTORY_WINDOW = 200
/**
 * Prefetch the older window this close to the top at the latest: a few
 * screens, so the window lands before the user reaches the oldest row.
 */
export const PREFETCH_OLDER_PX = 3000
/** Or as soon as the first turn in view is among this oldest share of the loaded turns. */
export const PREFETCH_OLDER_TURN_SHARE = 0.25

/** Older rows go first; a row already shown (by id) is not repeated. */
export function prependOlder(current: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const shown = new Set(current.map((message) => message.id))
  const fresh = older.filter((message) => !shown.has(message.id))
  return fresh.length > 0 ? [...fresh, ...current] : current
}

/**
 * The backend's newest window, followed by the shown rows newer than its last
 * row (live rows the backend has not stored yet). Null when no shown row is in
 * the window: nothing tells live rows from rows the backend no longer holds.
 */
export function rebaseOnNewest(current: ChatMessage[], newest: ChatMessage[]): ChatMessage[] | null {
  const inWindow = new Set(newest.map((message) => message.id))
  let lastShared = -1
  for (let i = current.length - 1; i >= 0; i--) {
    if (inWindow.has(current[i].id)) { lastShared = i; break }
  }
  return lastShared < 0 ? null : [...newest, ...current.slice(lastShared + 1)]
}

/** The rows of a full history that come before `firstShownId`, or null when it is not there. */
export function olderThan(full: ChatMessage[], firstShownId: string): ChatMessage[] | null {
  const index = full.findIndex((message) => message.id === firstShownId)
  return index < 0 ? null : full.slice(0, index)
}

export interface OlderLoadState {
  scrollTop: number
  /** Index of the first turn in view, or null when none is laid out. */
  firstVisibleTurn: number | null
  turnCount: number
  hasOlder: boolean
  loading: boolean
}

/** Whether to fetch the previous window now, whichever of the two prefetch points comes first. */
export function shouldLoadOlder(state: OlderLoadState): boolean {
  if (!state.hasOlder || state.loading) return false
  if (state.scrollTop <= PREFETCH_OLDER_PX) return true
  return state.firstVisibleTurn !== null && state.firstVisibleTurn < state.turnCount * PREFETCH_OLDER_TURN_SHARE
}

/** Index of the turn holding `messageId`, or -1. */
export function turnIndexHolding(turns: ChatMessage[][], messageId: string): number {
  return turns.findIndex((turn) => turn.some((message) => message.id === messageId))
}

/** Whether the store holds every row with its image bytes and whole tool calls, as an export needs. */
export function holdsWholeHistory(session: { messages: ChatMessage[]; olderHistoryCursor?: string | null }): boolean {
  return !session.olderHistoryCursor && !session.messages.some((message) =>
    message.images?.some((image) => image.ref) || message.toolCalls?.some((call) => call.preview))
}
