/**
 * Settle: the user (or a merged linked PR) takes a finished chat out of
 * Recents' "Done recently". The chat keeps its place in the workspace tree.
 * Desktop, Expo and Android share these rules.
 */
import type { PrState } from './pull-requests'

/**
 * Whether a chat is settled. The backend clears the stamp when a new user turn
 * starts, so a rename or a model change (which move the activity time) does not.
 */
export function isSettled(settledAt: number | null | undefined): boolean {
  return settledAt != null
}

/**
 * Whether a linked PR's state change settles its chat: only a change to
 * merged, only for a chat that is idle (no turn running, nothing waiting on
 * the user) and not settled already. The caller passes changes only, so a
 * PR read as merged again does not settle a chat the user brought back.
 */
export function shouldAutoSettle(input: {
  state: PrState
  busy: boolean
  needsUser: boolean
  settledAt: number | null
}): boolean {
  return input.state === 'merged' && !input.busy && !input.needsUser && !isSettled(input.settledAt)
}

/** Broadcast after a chat is settled or unsettled; `prNumber` when a merged PR settled it. */
export interface ConversationSettledEvent {
  conversationId: string
  settledAt: number | null
  title?: string
  prNumber?: number
  /**
   * The snooze this settle ended. Its Undo snoozes again with these values and
   * `expectRev: rev`, a write that also unsettles; a PR that merged keeps only the time.
   */
  endedSnooze?: { until: number | null; pr: string | null; rev: number }
}

export function settledNoticeText(title: string, prNumber?: number): string {
  return prNumber === undefined ? `Settled ${title}` : `Settled ${title}: PR #${prNumber} merged`
}
