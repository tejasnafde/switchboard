/**
 * Recovers approval/question/plan cards a resume gap or a reload dropped,
 * for mobile's flat FeedItem feed. Mirrors the desktop's
 * `renderer/services/pending-request-recovery.ts`; both key off requestId/planId
 * via `@shared/pending-requests`, so a card cannot land under two different
 * ids depending on which client recovered it.
 */
import { missingPendingRequests, pendingRequestKey, type PendingBlockingEvent } from '@shared/pending-requests'
import { REQUEST_EXPIRED } from '@shared/provider-events'
import type { FeedItem } from '../stores/chat'

/** The requestId/planId already represented among a thread's shown feed items. */
export function shownPendingKeys(items: readonly FeedItem[]): Set<string> {
  const keys = new Set<string>()
  for (const item of items) {
    if (item.kind === 'approval' || item.kind === 'question') keys.add(item.requestId)
    else if (item.kind === 'plan') keys.add(item.planId)
  }
  return keys
}

/** Pending events not already shown in this thread's feed. */
export function missingPendingFeedItems(
  pending: readonly PendingBlockingEvent[],
  items: readonly FeedItem[],
): PendingBlockingEvent[] {
  return missingPendingRequests(pending, shownPendingKeys(items))
}

export const NO_LONGER_WAITING = 'The agent is no longer waiting for an answer.'

/** The backend refused an answer because nothing waits for it any more. */
export function isExpiredAnswer(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(REQUEST_EXPIRED)
}

/** Request ids of approval and question cards still open in the feed. */
export function openRequestIds(items: readonly FeedItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.kind === 'approval' && !item.closed) ids.add(item.requestId)
    else if (item.kind === 'question' && !item.answers) ids.add(item.requestId)
  }
  return ids
}

/**
 * Cards that were open before the backend was asked and that it no longer
 * holds: their provider died while this phone was away. Only cards shown
 * before the call count, so one that opened while it was on the wire is kept.
 */
export function expiredOpenRequests(
  openBefore: ReadonlySet<string>,
  pending: readonly PendingBlockingEvent[],
): string[] {
  const held = new Set(pending.map(pendingRequestKey))
  return [...openBefore].filter((id) => !held.has(id))
}
