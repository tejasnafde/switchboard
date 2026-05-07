/**
 * Per-thread buffer for the "Stream assistant messages" toggle.
 *
 * When the toggle is OFF, ChatPanel routes every `content` runtime
 * event through `bufferContent` instead of dispatching to the agent
 * store. The buffer keeps the latest `text` snapshot for each
 * `(threadId, messageId)` pair (content events ship the full
 * accumulated text on every delta, not just the new chars). On
 * `turn.completed`, ChatPanel calls `drainTurn(threadId)` to flush
 * everything for that thread as a single batch — same UX as t3code's
 * server-side `delivery: "buffered"` mode but implemented renderer-side
 * because we don't have an orchestration layer to gate it server-side.
 *
 * The map insertion-order property of JS Maps is load-bearing: drainTurn
 * returns entries in the order their messageId first appeared, so a
 * conversation that emits two assistant messages in one turn renders
 * them in the right sequence.
 */

export type StreamingBuffer = Map<string, Map<string, string>>

export function createStreamingBuffer(): StreamingBuffer {
  return new Map()
}

export function bufferContent(
  buffer: StreamingBuffer,
  threadId: string,
  messageId: string,
  text: string,
): void {
  let perThread = buffer.get(threadId)
  if (!perThread) {
    perThread = new Map()
    buffer.set(threadId, perThread)
  }
  perThread.set(messageId, text)
}

export interface DrainedEntry {
  messageId: string
  text: string
}

export function drainTurn(buffer: StreamingBuffer, threadId: string): DrainedEntry[] {
  const perThread = buffer.get(threadId)
  if (!perThread) return []
  const entries: DrainedEntry[] = []
  for (const [messageId, text] of perThread) {
    entries.push({ messageId, text })
  }
  buffer.delete(threadId)
  return entries
}
