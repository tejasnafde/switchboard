/**
 * What is worth waking a phone for, and what the notification should say.
 *
 * Pure and shared so the rule is one implementation and can be tested without a
 * device or a network. The backend decides - the phone is asleep and cannot.
 */
import { fmtDuration } from './format'
import type { RuntimeEvent } from './provider-events'

export interface PushMessage {
  title: string
  body: string
  /**
   * Routed by the app when the notification is tapped. `clientRef` is the id
   * the device used when it registered, echoed back so the app knows WHICH
   * paired backend sent this - the backend cannot know the client's own naming.
   */
  data: { threadId: string; kind: PushKind; projectPath?: string; clientRef?: string; title?: string }
}

export type PushKind = 'approval' | 'question' | 'done' | 'error'

/**
 * Android 8+ delivers only through a channel, and a payload naming a channel
 * the device has not created is dropped silently. Shared so the sender and the
 * app cannot disagree.
 */
export const ANDROID_CHANNEL_ID = 'switchboard-agents'

/** Trim to something that fits a notification shade without a wall of text. */
export function clampBody(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export interface PushContext {
  /** Conversation title, for the notification heading. */
  title?: string
  /**
   * True when this phone is already looking at this thread. A notification for
   * the screen in the user's hand is noise.
   */
  isViewing?: boolean
}

/**
 * Map a runtime event to a notification, or null for events not worth sending.
 *
 * Only four kinds qualify. A blocked agent is the important one: it waits
 * indefinitely, so a missed approval costs the user a whole run. Streamed
 * content and tool calls are deliberately excluded - they would fire hundreds
 * of times per turn.
 */
export function pushForEvent(event: RuntimeEvent, ctx: PushContext = {}): PushMessage | null {
  if (ctx.isViewing) return null
  const title = ctx.title?.trim() || 'Switchboard'
  const threadId = event.threadId

  switch (event.type) {
    case 'request.opened':
      return {
        title,
        body: clampBody(`Needs approval: ${event.toolName}${event.detail ? ` - ${event.detail}` : ''}`),
        data: { threadId, kind: 'approval' },
      }

    case 'question.asked': {
      const first = event.questions[0]?.question
      return {
        title,
        body: clampBody(first ? `Asked: ${first}` : 'The agent asked a question'),
        data: { threadId, kind: 'question' },
      }
    }

    case 'turn.completed':
      // What you want off a lock screen is "which chat, and is it worth walking
      // back to" - so the conversation title (already the heading) and how long
      // it took. The cost was the wrong number: it is the one thing that cannot
      // tell you whether to look, and it turned every turn into a billing
      // notice. It is still on the turn in the app.
      return {
        title,
        body: clampBody(
          event.durationMs != null && event.durationMs > 0
            ? `Done in ${fmtDuration(event.durationMs)}`
            : 'Done',
        ),
        data: { threadId, kind: 'done' },
      }

    case 'error':
      return { title, body: clampBody(`Error: ${event.message}`), data: { threadId, kind: 'error' } }

    default:
      return null
  }
}

/** Expo push tokens look like `ExponentPushToken[…]` or `ExpoPushToken[…]`. */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value)
}

/**
 * Viewer ref the desktop reports under. It has no push token, so it needs an id
 * of its own to hold a slot in the viewing map alongside real devices.
 */
export const DESKTOP_VIEWER_REF = 'desktop'

/**
 * A client's claim that it has a thread on screen, as a LEASE that expires
 * unless renewed.
 *
 * A permanent claim meant a phone force-quit with a thread open never got
 * another notification for it, and a desktop in the same state silenced every
 * phone, because desktop viewing is a global veto.
 */
export interface ViewingLease {
  threadId: string
  atMs: number
}

/** A lease older than this is ignored. */
export const VIEWING_LEASE_TTL_MS = 180_000
/** A third of the TTL, so two renewals can be lost before the user is notified
 *  about the screen in their hand. */
export const VIEWING_RENEW_MS = 60_000

export function isLeaseLive(lease: ViewingLease, nowMs: number): boolean {
  return nowMs - lease.atMs < VIEWING_LEASE_TTL_MS
}

/**
 * Devices still worth notifying about `threadId`.
 *
 * `viewing` maps a viewer ref to its lease. A ref that is not an Expo token
 * belongs to a client we cannot push to - the desktop - and the user reading
 * there makes the notification noise on EVERY phone, not just one.
 */
export function pushTargets<T extends { token: string }>(
  devices: readonly T[],
  threadId: string,
  viewing: ReadonlyMap<string, ViewingLease>,
  nowMs: number = Date.now(),
): T[] {
  for (const [ref, lease] of viewing) {
    if (lease.threadId === threadId && isLeaseLive(lease, nowMs) && !isExpoPushToken(ref)) return []
  }
  return devices.filter((d) => {
    const lease = viewing.get(d.token)
    return !(lease && lease.threadId === threadId && isLeaseLive(lease, nowMs))
  })
}
