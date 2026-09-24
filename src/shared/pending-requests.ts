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
  RuntimeEvent,
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

/** The event types `applyPendingRequestEvent` can act on. */
export const PENDING_REQUEST_EVENT_TYPES: ReadonlySet<RuntimeEvent['type']> = new Set([
  'request.opened', 'question.asked', 'plan.proposed', 'request.closed', 'question.answered', 'status', 'user.message',
])

/**
 * A client's copy of one thread's open cards, advanced by a live event. The
 * same rules as the registry's own record in `provider-registry.ts`
 * `publish()`: an open event adds (or replaces) its card, the matching close
 * removes it, a provider that errored or stopped leaves nothing open, and a
 * plan stays until the user sends the next turn. Returns `current` itself
 * when the event changes nothing.
 *
 * `user.message` is exactly the set of turns the registry clears plans for:
 * it is published only by the two submit paths whose preparation calls
 * `clearPendingPlans`, and that preparation runs for a queued or steered send
 * too, clearing plans but never an open approval or question. A peer message
 * publishes `peer.message` instead and leaves plans open, here as there.
 */
export function applyPendingRequestEvent(
  current: readonly PendingBlockingEvent[],
  event: RuntimeEvent,
): readonly PendingBlockingEvent[] {
  switch (event.type) {
    case 'request.opened':
    case 'question.asked':
    case 'plan.proposed': {
      const key = pendingRequestKey(event)
      return [...current.filter((open) => pendingRequestKey(open) !== key), event]
    }
    case 'request.closed':
    case 'question.answered': {
      const next = current.filter((open) => open.type === 'plan.proposed' || open.requestId !== event.requestId)
      return next.length === current.length ? current : next
    }
    case 'status':
      return (event.status === 'error' || event.status === 'stopped') && current.length > 0 ? [] : current
    case 'user.message': {
      const next = current.filter((open) => open.type !== 'plan.proposed')
      return next.length === current.length ? current : next
    }
    default:
      return current
  }
}
