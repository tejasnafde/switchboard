/**
 * The registry's record of messages an adapter holds until the running turn
 * ends, so any client can list them and a promote or cancel can find them.
 *
 * Adapters announce a held message with only its id (`turn.queued`); the
 * ledger fills in the text and time from the submission the registry was
 * dispatching, which it learns through `expect` just before the dispatch.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import { releasesOutstandingTurn, type QueuedTurnSummary } from '@shared/turn-delivery'

export interface QueuedTurnObservation {
  /** The event to publish: `turn.queued` comes back with text and time. */
  event: RuntimeEvent
  /** A held message left without a `turn.completed` of its own to come. */
  releasesOutstandingTurn: boolean
}

export class QueuedTurnLedger {
  private readonly expected = new Map<string, { text: string; queuedAt: number }>()
  private readonly byThread = new Map<string, Map<string, QueuedTurnSummary>>()

  /** A `delivery: 'queue'` dispatch is about to run for this message. */
  expect(messageId: string, text: string, queuedAt: number): void {
    this.expected.set(messageId, { text, queuedAt })
  }

  /** The dispatch settled; a `turn.queued` for it has arrived by now or never will. */
  settle(messageId: string): void {
    this.expected.delete(messageId)
  }

  observe(event: RuntimeEvent, provider: string | undefined): QueuedTurnObservation {
    if (event.type === 'turn.queued') {
      const expected = this.expected.get(event.messageId)
      const turn: QueuedTurnSummary = {
        threadId: event.threadId,
        messageId: event.messageId,
        text: event.text ?? expected?.text ?? '',
        queuedAt: event.queuedAt ?? expected?.queuedAt ?? Date.now(),
      }
      let turns = this.byThread.get(event.threadId)
      if (!turns) {
        turns = new Map()
        this.byThread.set(event.threadId, turns)
      }
      turns.set(turn.messageId, turn)
      return { event: { ...event, text: turn.text, queuedAt: turn.queuedAt }, releasesOutstandingTurn: false }
    }
    if (event.type === 'turn.dequeued') {
      const turns = this.byThread.get(event.threadId)
      const known = turns?.delete(event.messageId) ?? false
      if (turns?.size === 0) this.byThread.delete(event.threadId)
      const exit = event.reason
      const releases = known && (exit === 'cancelled' || exit === 'promoted') && releasesOutstandingTurn(provider ?? '', exit)
      return { event, releasesOutstandingTurn: releases }
    }
    return { event, releasesOutstandingTurn: false }
  }

  get(threadId: string, messageId: string): QueuedTurnSummary | undefined {
    return this.byThread.get(threadId)?.get(messageId)
  }

  list(threadId: string): QueuedTurnSummary[] {
    return [...(this.byThread.get(threadId)?.values() ?? [])]
  }

  clear(threadId: string): void {
    this.byThread.delete(threadId)
  }
}
