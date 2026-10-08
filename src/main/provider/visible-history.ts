import { withHandoffPreamble } from '@shared/handoff'
import { createMainLogger } from '../logger'

const log = createMainLogger('provider:visible-history')

/** Adapter session state for a native session that could not be resumed. */
export interface VisibleHistoryState {
  /** Set when the resume failed: the next message carries the visible conversation. */
  needsVisibleHistory?: boolean
  portableHistory?: () => Promise<string | null>
}

/**
 * `message` with the visible conversation in front, once, after a failed
 * native resume; otherwise unchanged. A failed read sends it without.
 */
export async function withVisibleHistory(state: VisibleHistoryState, threadId: string, message: string): Promise<string> {
  if (!state.needsVisibleHistory || !state.portableHistory) return message
  state.needsVisibleHistory = false
  try {
    const preamble = await state.portableHistory()
    return preamble ? withHandoffPreamble(message, preamble) : message
  } catch (err) {
    log.warn(`could not load the visible conversation for ${threadId}; the new session starts without it`, err)
    return message
  }
}
