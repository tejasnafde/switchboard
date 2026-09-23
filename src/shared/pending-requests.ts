/**
 * Requests, questions and proposed plans that block a thread until a human
 * responds. A client normally learns about one from a live `request.opened` /
 * `question.asked` / `plan.proposed` event, but a resume gap (server restart,
 * an evicted replay cursor) or a window reload drops that event for good - no
 * equivalent ever re-arrives, so the turn looks like it is waiting on nothing.
 *
 * `ProviderChannels.GET_PENDING_REQUESTS` returns the backend's own record of
 * what is still open for a thread; a client calls it after such a gap, or on
 * ordinary reconnect/thread-open, and appends whatever card it is missing.
 */
import type {
  RuntimePlanProposedEvent,
  RuntimeQuestionAskedEvent,
  RuntimeRequestOpenedEvent,
} from './provider-events'

export type PendingBlockingEvent =
  | RuntimeRequestOpenedEvent
  | RuntimeQuestionAskedEvent
  | RuntimePlanProposedEvent

/**
 * The id a pending event is tracked and closed under: `requestId` for an
 * approval or a question, `planId` for a plan. A plan has no closing event of
 * its own - `ExitPlanMode` is denied immediately and the turn ends normally,
 * so a `plan.proposed` entry is cleared by the turn ending instead (see
 * `provider-registry.ts`'s `publish()`).
 */
export function pendingRequestKey(event: PendingBlockingEvent): string {
  return event.type === 'plan.proposed' ? event.planId : event.requestId
}

/**
 * Pending events not already represented among a thread's shown keys.
 *
 * Shared so desktop and mobile - which render these cards under their own,
 * different id schemes - cannot compute "already shown" differently and
 * duplicate or drop a card depending which client reconnected.
 */
export function missingPendingRequests(
  pending: readonly PendingBlockingEvent[],
  shownKeys: ReadonlySet<string>,
): PendingBlockingEvent[] {
  return pending.filter((event) => !shownKeys.has(pendingRequestKey(event)))
}
