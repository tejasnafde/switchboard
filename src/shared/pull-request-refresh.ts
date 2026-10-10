/**
 * When the Reviews view re-reads pull requests: on focus and every 5 minutes
 * while it is visible, never faster. A focus that lands within a minute of
 * the last read does nothing, so switching windows back and forth cannot
 * hammer the host; a manual refresh always goes.
 */
import type { PrSummary } from './pull-requests'

export const PR_REFRESH_INTERVAL_MS = 5 * 60_000
export const PR_FOCUS_MIN_GAP_MS = 60_000

export type PrRefreshReason = 'open' | 'focus' | 'interval' | 'manual'

export interface PrRefreshState {
  /** When the last read started, `null` before the first. */
  lastFetchAt: number | null
  inFlight: boolean
  visible: boolean
  /** Something the list does not show yet happened (an agent opened a PR): the next read goes whatever its reason. */
  stale?: boolean
}

export function shouldRefreshPullRequests(state: PrRefreshState, reason: PrRefreshReason, now: number): boolean {
  if (state.inFlight || !state.visible) return false
  if (state.lastFetchAt === null || state.stale === true || reason === 'manual') return true
  const age = now - state.lastFetchAt
  switch (reason) {
    case 'open':
    case 'interval':
      return age >= PR_REFRESH_INTERVAL_MS
    case 'focus':
      return age >= PR_FOCUS_MIN_GAP_MS
  }
}

/** Delay until the next interval read, from when the last one started. */
export function nextRefreshDelay(lastFetchAt: number | null, now: number): number {
  if (lastFetchAt === null) return 0
  return Math.max(0, lastFetchAt + PR_REFRESH_INTERVAL_MS - now)
}

/**
 * Whether a PR's cached tabs are stale after a list refresh. The updated time
 * alone misses what the host does not count as an update: a Bitbucket commit
 * status, or a conversation resolved without a new comment.
 */
export function pullRequestChanged(before: PrSummary, after: PrSummary): boolean {
  const a = before.checks
  const b = after.checks
  return (
    before.updatedAt !== after.updatedAt ||
    a.state !== b.state ||
    a.total !== b.total ||
    a.passed !== b.passed ||
    a.failed !== b.failed ||
    a.pending !== b.pending ||
    before.unresolvedConversations !== after.unresolvedConversations
  )
}
