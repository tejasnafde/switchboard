/**
 * What to do with a live connection when the app returns to the foreground.
 *
 * A phone's WebSocket does not close cleanly when the OS suspends it. Both ends
 * keep reporting OPEN, and nothing notices until an invoke times out 30s later
 * - which the user reads as the app being broken. So a foreground event has to
 * make a decision rather than assume the socket survived.
 *
 * Two cases, because they have different costs:
 *
 *  - **Short absence** (glance at a notification, switch apps briefly). The
 *    socket has almost certainly survived. Probe it: one ping, and only
 *    reconnect if the answer does not come back. Cheap, and it keeps the
 *    session and its subscriptions.
 *  - **Long absence.** The OS has very likely killed the socket silently, so a
 *    probe just adds a timeout before the inevitable. Replace the connection
 *    immediately, with no backoff - the user is looking at the screen now.
 *
 * Pure so it can be unit-tested; the caller supplies the clock.
 */

/**
 * Absence past this is treated as "the OS probably killed it". Ten seconds is
 * short enough that an app switch to copy a link still takes the cheap path,
 * and long enough that a real backgrounding does not waste a probe timeout.
 */
export const BACKGROUND_RECONNECT_AFTER_MS = 10_000

export type ForegroundAction = 'probe' | 'reconnect'

/**
 * `backgroundedAtMs` is null when the app was never actually backgrounded (iOS
 * fires `inactive` for a notification shade pull or a control-centre swipe).
 * That is not an absence, so it takes the cheap path.
 */
export function foregroundAction(backgroundedAtMs: number | null, activeAtMs: number): ForegroundAction {
  if (backgroundedAtMs === null) return 'probe'
  return activeAtMs - backgroundedAtMs >= BACKGROUND_RECONNECT_AFTER_MS ? 'reconnect' : 'probe'
}
