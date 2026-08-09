/**
 * How a screen gets out of the keyboard's way. One answer; the app previously
 * had three policies and two screens with none, which is why typing the first
 * message happened behind the keyboard.
 *
 * Android is the subtle half. Edge-to-edge is unconditional from Expo SDK 57,
 * so the window is not resized: `behavior: undefined` waits for a resize that
 * never comes, and a header-sized `keyboardVerticalOffset` double-counts a
 * header the measured frame already excludes.
 */
export type KeyboardBehavior = 'padding' | 'height'

export interface KeyboardAvoidance {
  behavior: KeyboardBehavior
  keyboardVerticalOffset: number
}

/** `headerHeight` is `useHeaderHeight()`, or 0 on a screen with no header. */
export function keyboardAvoidance(platform: string, headerHeight: number): KeyboardAvoidance {
  if (platform === 'ios') {
    return { behavior: 'padding', keyboardVerticalOffset: headerHeight }
  }
  return { behavior: 'height', keyboardVerticalOffset: 0 }
}
