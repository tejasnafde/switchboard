/**
 * Runtime events with saved secrets masked, before the registry stores or
 * publishes them. Streamed text is matched with a carry: the tail of a
 * message's deltas that could still grow into a match is held back
 * (`SecretRedactor.holdFrom`), so a value split across two deltas still
 * matches. Each stream (message id, stream kind, parent tool call) has its
 * own carry, so another message, a reasoning message, a subagent's text or a
 * tool call that arrives between two deltas does not release it. A held tail
 * goes out when a snapshot replaces its message, when the thread holds more
 * than `MAX_HELD_STREAMS` (the oldest), or when the turn stops (the turn end,
 * an error, a card that waits for the user). Events that carry no agent
 * output pass without releasing it.
 */
import type { RuntimeContentEvent, RuntimeEvent } from '@shared/provider-events'
import type { SecretRedactor, SecretScope } from './secret-redactor'

/** Events that leave a streamed message open, so its held tail stays held. */
const KEEPS_STREAM: ReadonlySet<RuntimeEvent['type']> = new Set([
  'content',
  'tool.started',
  'tool.completed',
  'tool.denied',
  'file.edited',
  'todo.updated',
  'task.notification',
  'approval.result',
  'context_window',
  'session',
  'session.provider',
  'model.variants',
  'turn.queued',
  'turn.dequeued',
  'turn.queue-held',
])

function keepsStream(event: RuntimeEvent): boolean {
  return KEEPS_STREAM.has(event.type) || (event.type === 'status' && event.status === 'running')
}

export type SecretMaskWhere = 'tool' | 'text' | 'diff'

export interface RedactedEvents {
  /** What to publish in place of the event, in order. */
  events: RuntimeEvent[]
  /** Where a value was masked, or null. */
  masked: { where: SecretMaskWhere; path?: string } | null
}

/** Carries one thread keeps at most; past it the oldest is sent. */
const MAX_HELD_STREAMS = 16

interface Held {
  messageId: string
  streamKind: RuntimeContentEvent['streamKind']
  parentToolCallId?: string
  text: string
}

/** Never cut between the two halves of a surrogate pair. */
function safeCut(text: string, at: number): number {
  if (at > 0 && at < text.length) {
    const code = text.charCodeAt(at)
    if (code >= 0xdc00 && code <= 0xdfff) return at - 1
  }
  return at
}

const streamKey = (e: { messageId: string; streamKind: string; parentToolCallId?: string }) =>
  `${e.messageId}\u0000${e.streamKind}\u0000${e.parentToolCallId ?? ''}`

export class RuntimeEventRedaction {
  /** Thread id to its held streams, by message id, stream kind and parent tool call, oldest first. */
  private readonly held = new Map<string, Map<string, Held>>()

  constructor(
    private readonly redactor: SecretRedactor,
    private readonly resolveScope: (threadId: string) => SecretScope,
  ) {}

  apply(event: RuntimeEvent): RedactedEvents {
    const events: RuntimeEvent[] = []
    const streams = this.held.get(event.threadId)
    let held: Held | undefined
    if (streams && event.type === 'content') {
      const key = streamKey(event)
      const prior = streams.get(key)
      if (prior && event.append === true) held = prior
      else if (prior) {
        streams.delete(key)
        if (prior.text) events.push(heldEvent(event.threadId, prior))
      }
    } else if (streams && !keepsStream(event)) {
      for (const prior of streams.values()) if (prior.text) events.push(heldEvent(event.threadId, prior))
      streams.clear()
    }
    if (streams?.size === 0) this.held.delete(event.threadId)
    if (!this.redactor.any()) {
      events.push(event)
      return { events, masked: null }
    }
    const root = this.resolveScope(event.threadId)
    if (!this.redactor.armed(root)) {
      events.push(event)
      return { events, masked: null }
    }
    if (event.type === 'content' && event.append === true) return this.applyDelta(root, event, held, events)
    const { event: next, masked } = this.maskWhole(root, event)
    events.push(next)
    return { events, masked }
  }

  /** One whole event masked, with no carry: for events that bypass the stream (changed-file cards). */
  mask<T extends RuntimeEvent>(event: T): { event: T; masked: RedactedEvents['masked'] } {
    if (!this.redactor.any()) return { event, masked: null }
    return this.maskWhole(this.resolveScope(event.threadId), event)
  }

  private maskWhole<T extends RuntimeEvent>(
    root: SecretScope,
    event: T,
  ): { event: T; masked: RedactedEvents['masked'] } {
    const { value, hit } = this.redactor.redactDeep(root, event)
    if (!hit) return { event, masked: null }
    if (value.type === 'file.edited') {
      // Accept or Reject would write the masked text back into the file.
      return {
        event: { ...value, noRevert: value.noRevert ?? 'unknown' },
        masked: { where: 'diff', path: value.relPath },
      }
    }
    const where = value.type === 'tool.started' || value.type === 'tool.completed' ? 'tool' : 'text'
    return { event: value, masked: { where } }
  }

  private applyDelta(
    root: SecretScope,
    event: RuntimeContentEvent,
    held: Held | undefined,
    events: RuntimeEvent[],
  ): RedactedEvents {
    const combined = (held?.text ?? '') + event.text
    const masked = this.redactor.redactText(root, combined)
    const text = masked ?? combined
    const cut = safeCut(text, this.redactor.holdFrom(root, text))
    let streams = this.held.get(event.threadId)
    if (!streams) {
      streams = new Map()
      this.held.set(event.threadId, streams)
    }
    const key = streamKey(event)
    streams.delete(key)
    if (cut > 0) events.push({ ...event, text: text.slice(0, cut) })
    if (cut < text.length) {
      streams.set(key, {
        messageId: event.messageId,
        streamKind: event.streamKind,
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        text: text.slice(cut),
      })
      if (streams.size > MAX_HELD_STREAMS) {
        const [oldestKey, oldest] = streams.entries().next().value as [string, Held]
        streams.delete(oldestKey)
        events.unshift(heldEvent(event.threadId, oldest))
      }
    }
    if (streams.size === 0) this.held.delete(event.threadId)
    return { events, masked: masked === null ? null : { where: 'text' } }
  }
}

function heldEvent(threadId: string, held: Held): RuntimeContentEvent {
  return {
    type: 'content',
    threadId,
    messageId: held.messageId,
    text: held.text,
    append: true,
    streamKind: held.streamKind,
    ...(held.parentToolCallId ? { parentToolCallId: held.parentToolCallId } : {}),
  }
}
