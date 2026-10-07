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
        ...(event.held ? { held: true } : {}),
      },
    }
  }
  if (event.type === 'turn.dequeued') {
    // Back on its row, marked: it never reached the agent.
    if (event.reason === 'failed') {
      return {
        ...state,
        [event.messageId]: { threadId: event.threadId, messageId: event.messageId, text: '', queuedAt: 0, failed: event.error || 'It could not start.' },
      }
    }
    if (!(event.messageId in state)) return state
    const next = { ...state }
    delete next[event.messageId]
    return next
  }
  if (event.type === 'turn.queue-held') {
    let changed = false
    const next: Record<string, QueuedTurnSummary> = {}
    for (const [id, turn] of Object.entries(state)) {
      const held = event.held && !turn.failed
      if (Boolean(turn.held) !== held) changed = true
      const copy: QueuedTurnSummary = { ...turn }
      if (held) copy.held = true
      else delete copy.held
      next[id] = copy
    }
    return changed ? next : state
  }
  // A session that stopped holds nothing any more. An error does not clear
  // the rows: the backend holds them after a failed turn, and announces each
  // one it drops (`turn.dequeued`).
  if (event.type === 'status' && event.status === 'stopped') {
    return Object.keys(state).length === 0 ? state : NO_QUEUED_TURNS
  }
  return state
}

/** Whether the queue waits for the user to resume it. */
export function queueIsHeld(state: QueuedTurnsByMessage): boolean {
  return Object.values(state).some((turn) => turn.held)
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
