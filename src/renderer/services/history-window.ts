import type { ChatMessage } from '@shared/types'

/** Rows per desktop history window: one window of a long chat is ~130 KB. */
export const DESKTOP_HISTORY_WINDOW = 200
/** Start loading the older window this close to the top of the list. */
export const LOAD_OLDER_THRESHOLD_PX = 400

/** Older rows go first; a row already shown (by id) is not repeated. */
export function prependOlder(current: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const shown = new Set(current.map((message) => message.id))
  const fresh = older.filter((message) => !shown.has(message.id))
  return fresh.length > 0 ? [...fresh, ...current] : current
}

/** The rows of a full history that come before `firstShownId`, or null when it is not there. */
export function olderThan(full: ChatMessage[], firstShownId: string): ChatMessage[] | null {
  const index = full.findIndex((message) => message.id === firstShownId)
  return index < 0 ? null : full.slice(0, index)
}

export function shouldLoadOlder(scrollTop: number, hasOlder: boolean, loading: boolean): boolean {
  return hasOlder && !loading && scrollTop <= LOAD_OLDER_THRESHOLD_PX
}

/** Index of the turn holding `messageId`, or -1. */
export function turnIndexHolding(turns: ChatMessage[][], messageId: string): number {
  return turns.findIndex((turn) => turn.some((message) => message.id === messageId))
}

/** Whether the store holds every row with its image bytes, as an export needs. */
export function holdsWholeHistory(session: { messages: ChatMessage[]; olderHistoryCursor?: string | null }): boolean {
  return !session.olderHistoryCursor && !session.messages.some((message) => message.images?.some((image) => image.ref))
}
