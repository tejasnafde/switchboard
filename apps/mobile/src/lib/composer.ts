/**
 * Composer button behaviour, as pure rules.
 *
 * The send button doubles as the mic, WhatsApp-style: with something to send it
 * sends, otherwise a press-and-hold dictates and a drag upward locks dictation
 * hands-free. Keeping the decision here means the gesture component stays dumb
 * and the rules are testable without a touch screen.
 */

export type ComposerMode = 'send' | 'mic' | 'stop-dictation' | 'stop-turn'

export interface ComposerInputs {
  /** Draft text or attachments present. */
  canSend: boolean
  /** A turn is streaming. */
  isRunning: boolean
  /** Dictation is active. */
  listening: boolean
  /** Dictation was locked by dragging up, so it survives the release. */
  locked: boolean
}

/**
 * What the primary button does right now.
 *
 * `stop-dictation` outranks everything: while locked, the button's job is to end
 * dictation, not to send half a sentence. Sending stays available during a turn
 * because a follow-up is queued rather than rejected.
 */
export function composerMode(i: ComposerInputs): ComposerMode {
  if (i.listening && i.locked) return 'stop-dictation'
  if (i.canSend) return 'send'
  if (i.isRunning) return 'stop-turn'
  return 'mic'
}

/** Upward travel, in points, that locks dictation. */
export const LOCK_DISTANCE = 56

/** Sideways travel that cancels instead of locking. */
export const CANCEL_DISTANCE = 72

export type GestureOutcome = 'locked' | 'cancelled' | 'none'

/**
 * Read a drag while holding the mic. Up locks, sideways cancels; whichever axis
 * dominates wins, so a sloppy diagonal resolves to the one the user meant.
 */
export function gestureOutcome(dx: number, dy: number): GestureOutcome {
  const up = -dy
  const sideways = Math.abs(dx)
  if (up >= LOCK_DISTANCE && up >= sideways) return 'locked'
  if (sideways >= CANCEL_DISTANCE && sideways > up) return 'cancelled'
  return 'none'
}

/** Hint shown while holding, so the gesture is discoverable. */
export function holdHint(outcome: GestureOutcome): string {
  switch (outcome) {
    case 'locked':
      return 'Release to keep recording'
    case 'cancelled':
      return 'Release to cancel'
    default:
      return 'Slide up to lock, sideways to cancel'
  }
}
