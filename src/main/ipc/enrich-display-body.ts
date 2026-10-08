/**
 * Merge persisted pill metadata onto JSONL-parsed messages, keyed by
 * `(role='user', content)` - JSONL ids come from the SDK, DB ids from
 * the renderer, so we can't id-join. Identical content sent twice with
 * different pills is unsupported.
 */
import type { ChatMessage } from '@shared/types'
import type { DisplayBodyEnrichment } from '../db/database'
import { createMainLogger } from '../logger'
import { parsePersistedPillsMeta } from '../provider/pill-metadata'

const log = createMainLogger('ipc:enrich-display-body')

type PillsMetaParsed = NonNullable<ChatMessage['pillsMeta']>
type ImagesParsed = NonNullable<ChatMessage['images']>

export function enrichMessagesWithDisplayBody(
  messages: ChatMessage[],
  enrichments: Map<string, DisplayBodyEnrichment>,
): ChatMessage[] {
  if (enrichments.size === 0) return messages
  // One stored row can match many messages (a repeated prompt with images
  // matched 1,482 times in a real chat), so each is parsed once.
  const parsed = new Map<DisplayBodyEnrichment, Partial<ChatMessage>>()
  return messages.map((m) => {
    if (m.role !== 'user') return m
    const hit = enrichments.get(m.content)
    if (!hit) return m
    let updates = parsed.get(hit)
    if (!updates) {
      updates = enrichmentUpdates(hit)
      parsed.set(hit, updates)
    }
    return Object.keys(updates).length > 0 ? { ...m, ...updates } : m
  })
}

function enrichmentUpdates(hit: DisplayBodyEnrichment): Partial<ChatMessage> {
  const updates: Partial<ChatMessage> = {}
  if (hit.displayBody) {
    let parsed: PillsMetaParsed | null = null
    try {
      parsed = JSON.parse(hit.pillsMeta ?? '{}') as PillsMetaParsed
    } catch {
      // The parse error quotes the text, so only its size is logged.
      log.warn('corrupt pill metadata for enriched message - skipping', { bytes: Buffer.byteLength(hit.pillsMeta ?? '') })
      parsed = null
    }
    if (parsed) {
      updates.displayBody = hit.displayBody
      // Drop entries a stored row should never hold (bad ids, unknown kinds,
      // labels over the 120-char limit), as the live submission check does.
      updates.pillsMeta = parsePersistedPillsMeta(hit.pillsMeta) ?? {}
    }
  }

  if (hit.images) {
    try {
      const parsedImages = JSON.parse(hit.images) as ImagesParsed
      if (Array.isArray(parsedImages) && parsedImages.length > 0) {
        updates.images = parsedImages
      }
    } catch {
      log.warn('corrupt image metadata for enriched message - skipping', { bytes: Buffer.byteLength(hit.images) })
    }
  }

  return updates
}
