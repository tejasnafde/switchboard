/**
 * Settle: the user (or a merged linked PR) takes a finished chat out of
 * Recents' "Done recently". The chat keeps its place in the workspace tree.
 * Desktop, Expo and Android share these rules.
 */
import type { PrState } from './pull-requests'

/**
 * Whether a chat is settled. A chat with activity after it was settled (a new
 * turn moves `startedAt`, the list's last-activity time) shows again, so no
 * write path has to clear the stamp.
 */
export function isSettled(settledAt: number | null | undefined, lastActivity: number): boolean {
  return settledAt != null && settledAt >= lastActivity
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
  lastActivity: number
}): boolean {
  return input.state === 'merged' && !input.busy && !input.needsUser && !isSettled(input.settledAt, input.lastActivity)
}

/** Broadcast after a chat is settled or unsettled; `prNumber` when a merged PR settled it. */
export interface ConversationSettledEvent {
  conversationId: string
  settledAt: number | null
  title?: string
  prNumber?: number
}

export function settledNoticeText(title: string, prNumber?: number): string {
  return prNumber === undefined ? `Settled ${title}` : `Settled ${title}: PR #${prNumber} merged`
}
