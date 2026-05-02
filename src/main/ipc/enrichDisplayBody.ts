/**
 * Merge persisted pill metadata onto JSONL-parsed messages, keyed by
 * `(role='user', content)` — JSONL ids come from the SDK, DB ids from
 * the renderer, so we can't id-join. Identical content sent twice with
 * different pills is unsupported.
 */
import type { ChatMessage } from '@shared/types'
import type { DisplayBodyEnrichment } from '../db/database'

type PillsMetaParsed = NonNullable<ChatMessage['pillsMeta']>

export function enrichMessagesWithDisplayBody(
  messages: ChatMessage[],
  enrichments: Map<string, DisplayBodyEnrichment>,
): ChatMessage[] {
  if (enrichments.size === 0) return messages
  return messages.map((m) => {
    if (m.role !== 'user') return m
    const hit = enrichments.get(m.content)
    if (!hit) return m
    let parsed: PillsMetaParsed
    try {
      parsed = JSON.parse(hit.pillsMeta) as PillsMetaParsed
    } catch {
      return m
    }
    return { ...m, displayBody: hit.displayBody, pillsMeta: parsed }
  })
}
