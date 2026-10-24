/**
 * Rules for messages the backend holds until the running turn ends, and for
 * the composer's steer/queue toggle, kept out of ThreadScreen so vitest can
 * cover them (see AGENTS.md "Testing: two runners, one rule").
 */
import type { QueuedTurnsByMessage } from '@shared/queued-turns'
import {
  followUpDelivery,
  promoteUnavailableReason,
  type QueuedTurnSummary,
  type TurnDelivery,
} from '@shared/turn-delivery'

export interface QueueToggle {
  /** The next send waits for the running turn. */
  queues: boolean
  /** The selected segment: "Steer" or "Queue". */
  label: 'Steer' | 'Queue'
  accessibilityLabel: string
  /** What the next send does, read as the state of the segment. */
  hint: string
}

/**
 * The Steer | Queue segment in the composer footer while a turn runs. `flipped`
 * is the one-send override of the device's default, the phone's equivalent of
 * Option+Enter. Same text as Android's `TurnDeliveryPolicy.queueToggle`.
 */
export function queueToggle(preferred: TurnDelivery, flipped: boolean): QueueToggle {
  const queues = followUpDelivery(preferred, flipped) === 'queue'
  const label = queues ? 'Queue' : 'Steer'
  if (preferred === 'steer') {
    return {
      queues,
      label,
      accessibilityLabel: 'Send after this turn instead of steering it',
      hint: queues ? 'Sends after this turn' : 'Steering the running turn · tap to queue',
    }
  }
  return {
    queues,
    label,
    accessibilityLabel: 'Steer the running turn instead of queueing',
    hint: queues ? 'Sends after this turn · tap to steer' : 'Steering the running turn',
  }
}

/** The held message a feed row shows, whether the row came live or from history (`h-`). */
export function heldTurnFor(held: QueuedTurnsByMessage | undefined, itemId: string): QueuedTurnSummary | undefined {
  if (!held) return undefined
  return held[itemId] ?? (itemId.startsWith('h-') ? held[itemId.slice(2)] : undefined)
}

export interface HeldTurnActions {
  /** The chip: Queued, Held (waits for Resume) or Not sent (could not start). */
  label: 'Queued' | 'Held' | 'Not sent'
  canPromote: boolean
  /** The queue is held after Stop or a failed turn: Resume replaces Send now. */
  canResume: boolean
  /** Shown instead of the default hint when Send now is unavailable. */
  hint: string
}

export function heldTurnActions(provider: string | undefined, turn?: QueuedTurnSummary): HeldTurnActions {
  if (turn?.failed) return { label: 'Not sent', canPromote: false, canResume: false, hint: turn.failed }
  if (turn?.held)
    return {
      label: 'Held',
      canPromote: false,
      canResume: true,
      hint: 'Held after a stop or a failed turn. Resume sends the queue.',
    }
  const blocked = promoteUnavailableReason(provider)
  return { label: 'Queued', canPromote: blocked === null, canResume: false, hint: blocked ?? 'Runs after this turn' }
}
