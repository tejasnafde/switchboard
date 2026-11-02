/**
 * Edge-swipe-back rules.
 *
 * react-navigation's `gestureEnabled` is iOS-only on the native stack, and the
 * JS stack that implements it on Android needs gesture-handler and reanimated -
 * native modules, so a new build. This does it with PanResponder instead, which
 * ships in React Native and therefore over OTA.
 *
 * Pure, so the thresholds are testable without a touch screen.
 */

/** How far from the left edge a swipe must START to count as a back gesture. */
export const EDGE_WIDTH = 32

/** Horizontal travel before the gesture is claimed from the feed's scroll. */
const CLAIM_DX = 12

/** Horizontal dominance required, so a diagonal scroll is not stolen. */
const DOMINANCE = 1.5

/** Travel that commits to going back on release. */
export const COMMIT_DX = 80

/** Flick velocity that commits regardless of distance. */
export const COMMIT_VX = 0.5

/**
 * Whether to take over the touch.
 *
 * Deliberately strict: the thread feed is a vertical list, and stealing an
 * ambiguous drag would break scrolling, which is used far more often than back.
 */
export function shouldClaimEdgeSwipe(startX: number, dx: number, dy: number): boolean {
  if (startX > EDGE_WIDTH) return false
  if (dx < CLAIM_DX) return false
  return dx > Math.abs(dy) * DOMINANCE
}

/** Whether a released swipe should navigate back. */
export function edgeSwipeCommits(dx: number, vx: number): boolean {
  return dx >= COMMIT_DX || vx >= COMMIT_VX
}

/** Leftward travel on a Home row that opens its Snooze sheet on release. */
export const ROW_SWIPE_COMMIT_DX = 72

/** Whether a Home row takes a drag: leftward and clearly horizontal, so the list still scrolls. */
export function shouldClaimRowSwipe(dx: number, dy: number): boolean {
  return dx <= -CLAIM_DX && -dx > Math.abs(dy) * DOMINANCE
}

/** Whether a released row swipe opens the sheet. */
export function rowSwipeCommits(dx: number, vx: number): boolean {
  return dx <= -ROW_SWIPE_COMMIT_DX || vx <= -COMMIT_VX
}
