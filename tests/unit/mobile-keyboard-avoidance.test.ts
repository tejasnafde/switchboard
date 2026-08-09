/**
 * One keyboard-avoidance policy for every screen that has a text input.
 *
 * The app had three policies and two screens with none, which is why the
 * composer and the new-session "first message" field both ended up under the
 * keyboard. The Android half is the part that is easy to get wrong: edge-to-edge
 * is unconditional from Expo SDK 57, the window is no longer resized for the
 * keyboard, and the React Navigation `keyboardVerticalOffset={headerHeight}`
 * recipe is an iOS recipe that double-counts the header on Android.
 */
import { describe, it, expect } from 'vitest'
import { keyboardAvoidance } from '../../apps/mobile/src/lib/keyboardAvoidance'

describe('keyboardAvoidance on ios', () => {
  it('pads the container, which leaves the list scrolled where the user left it', () => {
    expect(keyboardAvoidance('ios', 0).behavior).toBe('padding')
  })

  it('offsets by the header, because padding is measured from the window', () => {
    expect(keyboardAvoidance('ios', 96).keyboardVerticalOffset).toBe(96)
  })

  it('offsets by nothing on a screen with no header', () => {
    expect(keyboardAvoidance('ios', 0).keyboardVerticalOffset).toBe(0)
  })
})

describe('keyboardAvoidance on android', () => {
  it('shrinks the container, because edge-to-edge means nothing else will', () => {
    // `undefined` (the old value on the pair and rename screens) relies on the
    // window resizing under it. Under edge-to-edge it does not, so the keyboard
    // simply covers the input.
    expect(keyboardAvoidance('android', 0).behavior).toBe('height')
  })

  it('ignores the header height, which the measured frame already excludes', () => {
    // RN folds the offset into the overlap it computes. A header-sized offset
    // on top of a frame that already starts below the header inflates the
    // adjustment and lifts the composer into the middle of the screen.
    expect(keyboardAvoidance('android', 96).keyboardVerticalOffset).toBe(0)
  })
})
