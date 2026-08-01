/**
 * Read state shared with the phone.
 *
 * Unread used to be counted per client and only in memory, so reading a thread
 * here never cleared the badge on the phone. The backend now owns the read
 * point: opening a thread marks it read there, and the `thread.read` broadcast
 * clears the badge on every other client.
 *
 * The same focus tracking doubles as push suppression. The backend already
 * skips a phone that has the thread open; telling it the desktop has one open
 * stops it waking a phone the user is not looking at.
 */
import { useAgentStore } from '../stores/agent-store'
import { onProviderEvent } from './session-events'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:read-state')

let started = false

function markRead(threadId: string): void {
  window.api.app.markRead(threadId).catch((err: unknown) => {
    log.warn('mark-read failed', err)
  })
}

/**
 * Report the open thread, or `null` to withdraw the claim.
 *
 * Withdrawing on blur matters: a stale claim would keep suppressing pushes for
 * that thread long after the user walked away from the Mac.
 */
function reportViewing(threadId: string | null): void {
  if (!threadId) return
  window.api.push.reportViewing(threadId, document.hasFocus()).catch((err: unknown) => {
    log.warn('reportViewing failed', err)
  })
}

/** Idempotent - only the first call subscribes. Returns an unsubscribe fn. */
export function initSharedReadState(): () => void {
  if (started) return () => {}
  started = true

  let current = useAgentStore.getState().activeSessionId
  if (current) {
    markRead(current)
    reportViewing(current)
  }

  const unsubStore = useAgentStore.subscribe((state) => {
    const next = state.activeSessionId
    if (next === current) return
    current = next
    if (!next) return
    markRead(next)
    reportViewing(next)
  })

  // Subscribed globally rather than per ChatPanel: the badge lives in the
  // sidebar and has to clear for threads no panel has open.
  const unsubEvents = onProviderEvent((event) => {
    if (event.type !== 'thread.read') return
    useAgentStore.getState().markSessionRead(event.threadId)
  })

  const onFocusChange = (): void => reportViewing(current)
  window.addEventListener('focus', onFocusChange)
  window.addEventListener('blur', onFocusChange)

  return () => {
    unsubStore()
    unsubEvents()
    window.removeEventListener('focus', onFocusChange)
    window.removeEventListener('blur', onFocusChange)
    started = false
  }
}
