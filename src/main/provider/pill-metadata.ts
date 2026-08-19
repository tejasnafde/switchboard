import type { UserMessagePillsMeta } from '@shared/provider-events'

const PILL_ID = /^[A-Za-z0-9_-]+$/
const PILL_KINDS = new Set(['file', 'terminal', 'chat-message'])
const MAX_PILLS = 32
const MAX_PILL_ID_LENGTH = 128
const MAX_PILL_LABEL_LENGTH = 120

/** Decode the presentation-only pill metadata stored alongside a user turn. */
export function parsePersistedPillsMeta(raw: unknown): UserMessagePillsMeta | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
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

    pills[id] = { label, kind: kind as 'file' | 'terminal' | 'chat-message' }
    accepted += 1
  }

  return accepted > 0 ? pills : undefined
}
