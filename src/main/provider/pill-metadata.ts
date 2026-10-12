import type { UserMessagePillKind, UserMessagePillsMeta } from '@shared/provider-events'
import { createMainLogger } from '../logger'

const log = createMainLogger('provider:pill-metadata')

const PILL_ID = /^[A-Za-z0-9_-]+$/
const PILL_KINDS = new Set(['file', 'terminal', 'chat-message', 'review'])
const MAX_PILLS = 32
const MAX_PILL_ID_LENGTH = 128
const MAX_PILL_LABEL_LENGTH = 120
const MAX_SOURCE_ID_LENGTH = 256

/** An optional source id: kept when it is a short non-empty string, dropped otherwise. */
function sourceId(candidate: object, key: string): string | undefined {
  const value = Reflect.get(candidate, key)
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SOURCE_ID_LENGTH ? value : undefined
}

/** Decode the presentation-only pill metadata stored alongside a user turn. */
export function parsePersistedPillsMeta(raw: unknown): UserMessagePillsMeta | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // The stored value is the user's text: log its size, never its content.
    log.warn('stored pill metadata is not JSON', {
      bytes: Buffer.byteLength(raw, 'utf8'),
      error: error instanceof Error ? error.name : 'unknown',
    })
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const pills: UserMessagePillsMeta = Object.create(null) as UserMessagePillsMeta
  let accepted = 0
  for (const [id, candidate] of Object.entries(parsed)) {
    if (accepted >= MAX_PILLS) break
    if (id.length === 0 || id.length > MAX_PILL_ID_LENGTH || !PILL_ID.test(id)) continue
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue

    const label = Reflect.get(candidate, 'label')
    const kind = Reflect.get(candidate, 'kind')
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_PILL_LABEL_LENGTH) continue
    if (typeof kind !== 'string' || !PILL_KINDS.has(kind)) continue

    const sourceConversationId = sourceId(candidate, 'sourceConversationId')
    const sourceMessageId = sourceId(candidate, 'sourceMessageId')
    pills[id] = {
      label,
      kind: kind as UserMessagePillKind,
      ...(sourceConversationId && sourceMessageId ? { sourceConversationId, sourceMessageId } : {}),
    }
    accepted += 1
  }

  return accepted > 0 ? pills : undefined
}
