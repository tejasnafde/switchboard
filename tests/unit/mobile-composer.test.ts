/**
 * Composer button rules: what the primary button does, and how a hold-drag
 * resolves. Pure, so the gesture is testable without a touch screen.
 */
import { describe, it, expect } from 'vitest'
import {
  composerMode,
  gestureOutcome,
  holdHint,
  LOCK_DISTANCE,
  CANCEL_DISTANCE,
} from '../../apps/mobile/src/lib/composer'

const base = { canSend: false, isRunning: false, listening: false, locked: false }

describe('composerMode', () => {
  it('sends when there is something to send', () => {
    expect(composerMode({ ...base, canSend: true })).toBe('send')
  })

  it('is a mic on an empty idle composer', () => {
    expect(composerMode(base)).toBe('mic')
  })

  it('stops the turn when running with nothing to send', () => {
    expect(composerMode({ ...base, isRunning: true })).toBe('stop-turn')
  })

  it('still sends during a turn, because a follow-up is queued not refused', () => {
    expect(composerMode({ ...base, isRunning: true, canSend: true })).toBe('send')
  })

  it('ends locked dictation before anything else', () => {
    // Otherwise the button would send half a dictated sentence.
    expect(composerMode({ ...base, listening: true, locked: true, canSend: true })).toBe('stop-dictation')
    expect(composerMode({ ...base, listening: true, locked: true, isRunning: true })).toBe('stop-dictation')
  })

  it('treats unlocked dictation as a normal press-and-hold, not a mode', () => {
    // While held, releasing ends it; the button itself should still read as send
    // once text has been dictated in.
    expect(composerMode({ ...base, listening: true, canSend: true })).toBe('send')
  })
})

describe('gestureOutcome', () => {
  it('locks on enough upward travel', () => {
    expect(gestureOutcome(0, -LOCK_DISTANCE)).toBe('locked')
    expect(gestureOutcome(0, -LOCK_DISTANCE - 40)).toBe('locked')
  })

  it('does nothing for a small movement', () => {
    expect(gestureOutcome(0, 0)).toBe('none')
    expect(gestureOutcome(4, -10)).toBe('none')
  })

  it('ignores downward travel', () => {
    expect(gestureOutcome(0, LOCK_DISTANCE * 2)).toBe('none')
  })

  it('cancels on enough sideways travel, either direction', () => {
    expect(gestureOutcome(-CANCEL_DISTANCE, 0)).toBe('cancelled')
    expect(gestureOutcome(CANCEL_DISTANCE, 0)).toBe('cancelled')
  })

  it('resolves a sloppy diagonal to the dominant axis', () => {
    // Mostly up with some drift locks; mostly sideways cancels.
    expect(gestureOutcome(20, -80)).toBe('locked')
    expect(gestureOutcome(-90, -20)).toBe('cancelled')
  })

  it('prefers locking when both thresholds are crossed but up dominates', () => {
    expect(gestureOutcome(CANCEL_DISTANCE, -(CANCEL_DISTANCE + 10))).toBe('locked')
  })
})

describe('holdHint', () => {
  it('tells the user what release will do', () => {
    expect(holdHint('none')).toMatch(/slide up/i)
    expect(holdHint('locked')).toMatch(/keep recording/i)
    expect(holdHint('cancelled')).toMatch(/cancel/i)
  })
})
