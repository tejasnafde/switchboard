/**
 * Recovers approval/question/plan cards a resume gap or a reload dropped,
 * for mobile's flat FeedItem feed. Mirrors the desktop's
 * `renderer/services/pendingRequestRecovery.ts`; both key off requestId/planId
 * via `@shared/pending-requests`, so a card cannot land under two different
 * ids depending on which client recovered it.
 */
import { missingPendingRequests, type PendingBlockingEvent } from '@shared/pending-requests'
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
