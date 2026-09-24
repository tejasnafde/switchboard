/**
 * Rules for messages the backend holds until the running turn ends, and for
 * the composer's steer/queue toggle, kept out of ThreadScreen so vitest can
 * cover them (see AGENTS.md "Testing: two runners, one rule").
 */
import type { QueuedTurnsByMessage } from '@shared/queued-turns'
import { followUpDelivery, promoteUnavailableReason, type QueuedTurnSummary, type TurnDelivery } from '@shared/turn-delivery'

export interface QueueToggle {
  /** The next send waits for the running turn. */
  queues: boolean
  label: string
  accessibilityLabel: string
}

/**
 * The chip above the composer while a turn runs. `flipped` is the one-send
 * override of the device's default, the phone's equivalent of Option+Enter.
 */
export function queueToggle(preferred: TurnDelivery, flipped: boolean): QueueToggle {
  const queues = followUpDelivery(preferred, flipped) === 'queue'
  if (preferred === 'steer') {
    return {
      queues,
      label: queues ? 'Sends after this turn' : 'Steering the running turn · tap to queue',
      accessibilityLabel: 'Send after this turn instead of steering it',
    }
  }
  return {
    queues,
    label: queues ? 'Sends after this turn · tap to steer' : 'Steering the running turn',
    accessibilityLabel: 'Steer the running turn instead of queueing',
  }
}

/** The held message a feed row shows, whether the row came live or from history (`h-`). */
export function heldTurnFor(held: QueuedTurnsByMessage | undefined, itemId: string): QueuedTurnSummary | undefined {
  if (!held) return undefined
  return held[itemId] ?? (itemId.startsWith('h-') ? held[itemId.slice(2)] : undefined)
}

export interface HeldTurnActions {
  canPromote: boolean
  /** Shown instead of the default hint when Send now is unavailable. */
  hint: string
}

export function heldTurnActions(provider: string | undefined): HeldTurnActions {
  const blocked = promoteUnavailableReason(provider)
  return { canPromote: blocked === null, hint: blocked ?? 'Runs after this turn' }
}
