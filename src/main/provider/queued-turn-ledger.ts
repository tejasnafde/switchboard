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
  /** Threads whose adapter holds its queue until the user resumes it. */
  private readonly heldThreads = new Set<string>()
  /** The message each thread started last: only it can still report `failed`. */
  private readonly lastStarted = new Map<string, QueuedTurnSummary>()

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
      this.add(turn)
      const held = this.heldThreads.has(event.threadId)
      return {
        event: { ...event, text: turn.text, queuedAt: turn.queuedAt, ...(held ? { held: true } : {}) },
        releasesOutstandingTurn: false,
      }
    }
    if (event.type === 'turn.queue-held') {
      if (event.held) this.heldThreads.add(event.threadId)
      else this.heldThreads.delete(event.threadId)
      return { event, releasesOutstandingTurn: false }
    }
    if (event.type === 'turn.dequeued' && event.reason === 'failed') {
      // Listed again, marked, until the user cancels it. Its count is settled
      // by the adapter's own turn.completed.
      const started = this.lastStarted.get(event.threadId)
      this.lastStarted.delete(event.threadId)
      this.add({
        threadId: event.threadId,
        messageId: event.messageId,
        text: started?.messageId === event.messageId ? started.text : '',
        queuedAt: started?.messageId === event.messageId ? started.queuedAt : Date.now(),
        failed: event.error || 'It could not start.',
      })
      return { event, releasesOutstandingTurn: false }
    }
    if (event.type === 'turn.dequeued') {
      const turns = this.byThread.get(event.threadId)
      const turn = turns?.get(event.messageId)
      if (event.reason === 'started' && turn) this.lastStarted.set(event.threadId, turn)
      const known = turns?.delete(event.messageId) ?? false
      if (turns?.size === 0) this.byThread.delete(event.threadId)
      const exit = event.reason
      const releases = known && (exit === 'cancelled' || exit === 'promoted') && releasesOutstandingTurn(provider ?? '', exit)
      return { event, releasesOutstandingTurn: releases }
    }
    return { event, releasesOutstandingTurn: false }
  }

  private add(turn: QueuedTurnSummary): void {
    let turns = this.byThread.get(turn.threadId)
    if (!turns) {
      turns = new Map()
      this.byThread.set(turn.threadId, turns)
    }
    turns.set(turn.messageId, turn)
  }

  /** A failed message the user took back: it was never the adapter's to cancel. */
  removeFailed(threadId: string, messageId: string): QueuedTurnSummary | undefined {
    const turns = this.byThread.get(threadId)
    const turn = turns?.get(messageId)
    if (!turn?.failed) return undefined
    turns!.delete(messageId)
    if (turns!.size === 0) this.byThread.delete(threadId)
    return turn
  }

  get(threadId: string, messageId: string): QueuedTurnSummary | undefined {
    return this.byThread.get(threadId)?.get(messageId)
  }

  list(threadId: string): QueuedTurnSummary[] {
    const held = this.heldThreads.has(threadId)
    return [...(this.byThread.get(threadId)?.values() ?? [])].map((turn) => (held && !turn.failed ? { ...turn, held: true } : turn))
  }

  clear(threadId: string): void {
    this.byThread.delete(threadId)
    this.heldThreads.delete(threadId)
    this.lastStarted.delete(threadId)
  }
}
