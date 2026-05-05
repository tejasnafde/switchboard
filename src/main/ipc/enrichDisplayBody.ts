/**
 * Merge persisted pill metadata onto JSONL-parsed messages, keyed by
 * `(role='user', content)` — JSONL ids come from the SDK, DB ids from
 * the renderer, so we can't id-join. Identical content sent twice with
 * different pills is unsupported.
 */
import type { ChatMessage } from '@shared/types'
import type { DisplayBodyEnrichment } from '../db/database'

type PillsMetaParsed = NonNullable<ChatMessage['pillsMeta']>
type ImagesParsed = NonNullable<ChatMessage['images']>

export function enrichMessagesWithDisplayBody(
  messages: ChatMessage[],
  enrichments: Map<string, DisplayBodyEnrichment>,
): ChatMessage[] {
  if (enrichments.size === 0) return messages
  return messages.map((m) => {
    if (m.role !== 'user') return m
    const hit = enrichments.get(m.content)
    if (!hit) return m

    const updates: Partial<ChatMessage> = {}
    if (hit.displayBody) {
      let parsed: PillsMetaParsed | null = null
      try {
        parsed = JSON.parse(hit.pillsMeta ?? '{}') as PillsMetaParsed
      } catch {
        parsed = null
      }
      if (parsed) {
        updates.displayBody = hit.displayBody
        updates.pillsMeta = parsed
      }
    }

    if (hit.images) {
      try {
        const parsedImages = JSON.parse(hit.images) as ImagesParsed
        if (Array.isArray(parsedImages) && parsedImages.length > 0) {
          updates.images = parsedImages
        }
      } catch {
        // ignore corrupt image metadata
      }
    }

    return Object.keys(updates).length > 0 ? { ...m, ...updates } : m
  })
}
