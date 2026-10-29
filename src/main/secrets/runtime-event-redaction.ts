/**
 * Runtime events with saved secrets masked, before the registry stores or
 * publishes them. Streamed text is matched with a carry: the last
 * (longest pattern - 1) characters of a message's deltas are held back, so a
 * value split across two deltas still matches. The held tail goes out ahead
 * of the thread's next event that ends or interrupts the message: another
 * message, a tool call, a card, an error, the turn end. Events that carry no
 * agent output (a Switchboard notice row, a repeated `running`, token counts)
 * pass without releasing it.
 */
import type { RuntimeContentEvent, RuntimeEvent } from '@shared/provider-events'
import type { SecretRedactor, SecretScope } from './secret-redactor'

/** Events that leave a streamed message open, so its held tail stays held. */
const KEEPS_STREAM: ReadonlySet<RuntimeEvent['type']> = new Set([
  'approval.result',
  'context_window',
  'session',
  'session.provider',
  'model.variants',
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

export class RuntimeEventRedaction {
  private readonly held = new Map<string, Held>()

  constructor(
    private readonly redactor: SecretRedactor,
    private readonly resolveScope: (threadId: string) => SecretScope,
  ) {}

  apply(event: RuntimeEvent): RedactedEvents {
    const events: RuntimeEvent[] = []
    const held = this.held.get(event.threadId)
    const sameStream =
      held !== undefined &&
      event.type === 'content' &&
      event.append === true &&
      event.messageId === held.messageId &&
      event.streamKind === held.streamKind &&
      event.parentToolCallId === held.parentToolCallId
    if (held && !sameStream && !keepsStream(event)) {
      this.held.delete(event.threadId)
      if (held.text) events.push(heldEvent(event.threadId, held))
    }
    if (!this.redactor.any()) {
      events.push(event)
      return { events, masked: null }
    }
    const root = this.resolveScope(event.threadId)
    if (!this.redactor.armed(root)) {
      events.push(event)
      return { events, masked: null }
    }
    if (event.type === 'content' && event.append === true)
      return this.applyDelta(root, event, sameStream ? held : undefined, events)
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
    const cut = safeCut(text, Math.max(0, text.length - (this.redactor.longest(root) - 1)))
    this.held.set(event.threadId, {
      messageId: event.messageId,
      streamKind: event.streamKind,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      text: text.slice(cut),
    })
    if (cut > 0) events.push({ ...event, text: text.slice(0, cut) })
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
