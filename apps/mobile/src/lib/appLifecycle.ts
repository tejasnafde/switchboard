/**
 * What to do with a connection when the app returns to the foreground.
 *
 * A phone's socket does not close cleanly when the OS suspends it: both ends
 * keep reporting OPEN until an invoke times out. Under the threshold the socket
 * has probably survived, so probe it. Over it, a probe just adds a timeout
 * before the inevitable, so replace the connection outright.
 */

/** Short enough that an app switch to copy a link still takes the cheap path. */
export const BACKGROUND_RECONNECT_AFTER_MS = 10_000

export type ForegroundAction = 'probe' | 'reconnect'

/** `backgroundedAtMs` is null when the app was never actually backgrounded -
 *  iOS fires `inactive` for a notification shade pull, which is not an absence. */
export function foregroundAction(backgroundedAtMs: number | null, activeAtMs: number): ForegroundAction {
  if (backgroundedAtMs === null) return 'probe'
  return activeAtMs - backgroundedAtMs >= BACKGROUND_RECONNECT_AFTER_MS ? 'reconnect' : 'probe'
}
