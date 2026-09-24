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
import { VIEWING_RENEW_MS } from '@shared/push-policy'
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'
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
function reportViewing(threadId: string, viewing: boolean): void {
  window.api.push.reportViewing(threadId, viewing).catch((err: unknown) => {
    log.warn('reportViewing failed', err)
  })
}

export function readStateTargets(
  displayedSessionIds: readonly string[],
  focusedSessionId: string | null,
  appVisible: boolean,
): { markReadSessionIds: string[]; viewingSessionId: string | null } {
  if (!appVisible) return { markReadSessionIds: [], viewingSessionId: null }
  return {
    markReadSessionIds: [...displayedSessionIds],
    viewingSessionId: focusedSessionId ?? displayedSessionIds[0] ?? null,
  }
}

/** Idempotent - only the first call subscribes. Returns an unsubscribe fn. */
export function initSharedReadState(): () => void {
  if (started) return () => {}
  started = true

  let currentViewing: string | null = null
  let lastDisplayedKey = ''

  const sync = (): void => {
    const layout = useLayoutStore.getState()
    const appVisible = document.hasFocus() && document.visibilityState === 'visible'
    const targets = readStateTargets(
      layout.displayedChatSessionIds(),
      layout.focusedChatSessionId(),
      appVisible,
    )
    const displayedKey = targets.markReadSessionIds.join('\u0000')
    if (displayedKey !== lastDisplayedKey) {
      lastDisplayedKey = displayedKey
      for (const sessionId of targets.markReadSessionIds) {
        markRead(sessionId)
        useAgentStore.getState().markSessionRead(sessionId)
      }
    }
    if (targets.viewingSessionId === currentViewing) return
    if (currentViewing) reportViewing(currentViewing, false)
    currentViewing = targets.viewingSessionId
    if (currentViewing) reportViewing(currentViewing, true)
  }

  sync()
  const unsubStore = useLayoutStore.subscribe(sync)

  // Subscribed globally rather than per ChatPanel: the badge lives in the
  // sidebar and has to clear for threads no panel has open.
  const unsubEvents = onProviderEvent((event) => {
    if (event.type === 'thread.read') {
      useAgentStore.getState().markSessionRead(event.threadId)
      return
    }
    if (
      event.type === 'turn.completed'
      && document.hasFocus()
      && document.visibilityState === 'visible'
      && useLayoutStore.getState().displayedChatSessionIds().includes(event.threadId)
    ) {
      markRead(event.threadId)
      useAgentStore.getState().markSessionRead(event.threadId)
    }
  })

  const onFocusChange = (): void => {
    lastDisplayedKey = ''
    sync()
  }
  window.addEventListener('focus', onFocusChange)
  window.addEventListener('blur', onFocusChange)
  document.addEventListener('visibilitychange', onFocusChange)

  // The backend treats a viewing claim as a lease that expires, because a
  // client that dies without withdrawing it would otherwise suppress pushes
  // forever. Desktop viewing is a global veto, so a lapsed lease here means
  // every phone starts buzzing about a thread the user is reading.
  const renew = setInterval(() => {
    if (currentViewing && document.hasFocus() && document.visibilityState === 'visible') {
      reportViewing(currentViewing, true)
    }
  }, VIEWING_RENEW_MS)

  return () => {
    clearInterval(renew)
    unsubStore()
    unsubEvents()
    window.removeEventListener('focus', onFocusChange)
    window.removeEventListener('blur', onFocusChange)
    document.removeEventListener('visibilitychange', onFocusChange)
    if (currentViewing) reportViewing(currentViewing, false)
    started = false
  }
}
