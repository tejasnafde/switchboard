/**
 * Client-side bookkeeping for messages the backend holds until the running
 * turn ends. Desktop and the phone fold the same events through this, keyed
 * by the chat row id, so a `turn.queued` that arrives before the row's own
 * `user.message` echo still marks the right row once it lands.
 */
import type { RuntimeEvent } from './provider-events'
import { stripHandoffPreamble } from './handoff'
import type { QueuedTurnSummary } from './turn-delivery'

export type QueuedTurnsByMessage = Readonly<Record<string, QueuedTurnSummary>>

export const NO_QUEUED_TURNS: QueuedTurnsByMessage = Object.freeze({})

/** Fold one event; returns the same object when nothing changed. */
export function applyQueuedTurnEvent(state: QueuedTurnsByMessage, event: RuntimeEvent): QueuedTurnsByMessage {
  if (event.type === 'turn.queued') {
    return {
      ...state,
      [event.messageId]: {
        threadId: event.threadId,
        messageId: event.messageId,
        text: event.text ?? '',
        queuedAt: event.queuedAt ?? 0,
      },
    }
  }
  if (event.type === 'turn.dequeued') {
    if (!(event.messageId in state)) return state
    const next = { ...state }
    delete next[event.messageId]
    return next
  }
  // A session that stopped or died holds nothing any more.
  if (event.type === 'status' && (event.status === 'stopped' || event.status === 'error')) {
    return Object.keys(state).length === 0 ? state : NO_QUEUED_TURNS
  }
  return state
}

/**
 * The message never reached the agent, so its chat row goes on every client:
 * taken back by the user, or dropped (the backend stored a not-sent row with
 * its text instead).
 */
export function queuedRowRemoved(reason: string): boolean {
  return reason === 'cancelled' || reason === 'dropped'
}

/** Replace the state with what the backend reports (open, reconnect, resume gap). */
export function seedQueuedTurns(turns: readonly QueuedTurnSummary[]): QueuedTurnsByMessage {
  if (turns.length === 0) return NO_QUEUED_TURNS
  return Object.fromEntries(turns.map((turn) => [turn.messageId, turn]))
}

/**
 * The text to put back in the composer when a queued message is cancelled.
 * A pill-bearing body is only `[[pill:id]]` tokens, and the pill content is
 * gone with the draft, so the expanded text the agent would have read is the
 * faithful copy there. Otherwise what the user typed.
 */
export function queuedTurnComposerText(
  providerText: string,
  displayBody?: string,
  pillsMeta?: Readonly<Record<string, unknown>>,
): string {
  const hasPills = pillsMeta !== undefined && Object.keys(pillsMeta).length > 0
  if (displayBody !== undefined && !hasPills) return displayBody
  return stripHandoffPreamble(providerText)
}

export type QueuedTurnNotSentCause = 'stopped' | 'restarted'

/** What replaces a queued message that never ran. It keeps the text, which is all the user loses otherwise. */
export function queuedTurnNotSentMessage(text: string, cause: QueuedTurnNotSentCause): string {
  const why = cause === 'stopped' ? 'the session stopped before it ran' : 'Switchboard restarted before it ran'
  return `A queued message was not sent: ${why}. Send it again. Its text:\n\n${text}`
}
