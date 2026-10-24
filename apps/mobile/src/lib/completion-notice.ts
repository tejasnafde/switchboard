/**
 * A local "Done" notice for a turn that ends while the app is not in front and
 * the backend's push will not say so. Android's
 * `BackgroundTurnNotificationCoordinator`, with one change: Android replaces a
 * local notice with the remote one by id, iOS cannot, so a turn the backend
 * pushes gets no local notice here.
 *
 * Pure (no react-native) so the rule runs under vitest.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import type { PushMessage } from '@shared/push-policy'
import { fmtDuration } from '@shared/format'
import { isDemoConnection } from '@shared/phone-demo/phone-demo'

export const MAX_REMEMBERED_TURNS = 128
const MAX_TURN_ID_LENGTH = 512

export interface CompletionNoticeDeps {
  appActive: () => boolean
  /** The backend will push this turn: it holds this phone's token and the phone is not viewing the chat. */
  pushCovers: (connectionId: string, threadId: string) => boolean
  /** Resolves false when the notice could not be shown. */
  post: (notice: PushMessage) => Promise<boolean>
}

export function completionNoticeBody(durationMs: number | undefined): string {
  return durationMs != null && durationMs > 0 ? `Done in ${fmtDuration(durationMs)}` : 'Done'
}

export function createCompletionNotifier(deps: CompletionNoticeDeps) {
  const notified = new Set<string>()

  return async function onEvent(connectionId: string, event: RuntimeEvent): Promise<boolean> {
    if (event.type !== 'turn.completed' || event.threadId.trim() === '') return false
    if (deps.appActive() || isDemoConnection(connectionId)) return false
    if (deps.pushCovers(connectionId, event.threadId)) return false
    const turnId = event.turnId && event.turnId.length <= MAX_TURN_ID_LENGTH ? event.turnId : null
    const key = turnId ? `${connectionId}:${event.threadId}:${turnId}` : null
    if (key !== null) {
      if (notified.has(key)) return false
      notified.add(key)
      if (notified.size > MAX_REMEMBERED_TURNS) notified.delete(notified.values().next().value as string)
    }
    // Same payload shape as a remote push, so a tap opens the chat the same way.
    const posted = await deps.post({
      title: 'Switchboard',
      body: completionNoticeBody(event.durationMs),
      data: { threadId: event.threadId, kind: 'done', clientRef: connectionId },
    })
    if (!posted && key !== null) notified.delete(key)
    return posted
  }
}
