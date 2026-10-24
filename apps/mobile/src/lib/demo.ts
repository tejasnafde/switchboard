/**
 * Entering and leaving the demo (`@shared/phone-demo`). The demo connection is
 * runtime only, and every store that holds per-connection state drops the
 * demo's on the way out, so nothing from it outlives the session.
 */
import { DEMO_CONNECTION_ID, isDemoConnection, withoutDemo } from '@shared/phone-demo/phone-demo'
import { useChatStore } from '../stores/chat'
import { useConnectionsStore } from '../stores/connections'
import { useOutboxStore } from '../stores/outbox'
import { usePrefsStore } from '../stores/prefs'
import { useReviewsStore } from '../stores/reviews'
import { useSavedProjectsStore } from '../stores/saved-projects'

export function leaveDemo(): void {
  useConnectionsStore.getState().stopDemo()
  useChatStore.getState().forgetConnection(DEMO_CONNECTION_ID)
  usePrefsStore.setState((s) => ({ threads: withoutDemo(s.threads), prFilters: withoutDemo(s.prFilters) }))
  useReviewsStore.setState((s) => ({ byConnection: withoutDemo(s.byConnection) }))
  useSavedProjectsStore.getState().forget(DEMO_CONNECTION_ID)
  useOutboxStore.setState((s) => ({ messages: s.messages.filter((m) => !isDemoConnection(m.connectionId)) }))
}
