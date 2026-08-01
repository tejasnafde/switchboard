import type { ChatMessage } from '@shared/types'

/**
 * Collapse the same message arriving from more than one source. `load-by-id`
 * unions one session id out of every provider profile dir, so the same message
 * legitimately arrives N times.
 *
 * Exported rather than inline in the handler because the bug lived in the seam
 * between the parser's id and this key: with synthesized ids it removed nothing
 * for its whole life, and inline it could not be tested.
 */
export interface DedupeResult {
  messages: ChatMessage[]
  removed: number
  /**
   * Duplicate ids whose content did NOT match. Should always be 0, since
   * profile copies are byte-prefixes; non-zero means "first wins" discarded a
   * differing version, so the caller says so instead of passing it over.
   */
  conflicts: number
}

export function dedupeMessagesById(messages: ChatMessage[]): DedupeResult {
  const kept = new Map<string, ChatMessage>()
  const out: ChatMessage[] = []
  let removed = 0
  let conflicts = 0

  for (const m of messages) {
    const first = kept.get(m.id)
    if (first === undefined) {
      kept.set(m.id, m)
      out.push(m)
      continue
    }
    removed++
    if (!sameContent(first, m)) conflicts++
  }

  return { messages: out, removed, conflicts }
}

/** Fields that decide whether two copies of one id are the same message. */
function sameContent(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role
    && a.content === b.content
    && a.timestamp === b.timestamp
    && (a.toolCalls?.length ?? 0) === (b.toolCalls?.length ?? 0)
}
