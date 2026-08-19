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

const LEGACY_ID_MATCH_WINDOW_MS = 60_000

/**
 * Merge provider-owned history with Switchboard's SQLite mirror.
 *
 * Disk comes first because it can carry images and tool calls that the mirror
 * does not. SQLite is still unioned on every load, so a pruned prefix or an
 * out-of-band agent completion cannot disappear merely because one JSONL
 * fragment survived.
 */
export function mergeConversationMessages(
  diskMessages: ChatMessage[],
  databaseMessages: ChatMessage[],
): ChatMessage[] {
  const disk = dedupeMessagesById(diskMessages).messages.map(cloneMessage)
  const diskIndexesById = new Map(disk.map((message, index) => [message.id, index]))
  const semanticCandidates = new Map<string, Array<{ index: number; timestamp: number }>>()
  disk.forEach((message, index) => {
    const key = semanticMessageKey(message)
    const candidates = semanticCandidates.get(key) ?? []
    candidates.push({ index, timestamp: message.timestamp })
    semanticCandidates.set(key, candidates)
  })
  for (const candidates of semanticCandidates.values()) {
    candidates.sort((a, b) => a.timestamp - b.timestamp)
  }
  const candidateCursor = new Map<string, number>()
  const matchedDiskIndexes = new Set<number>()
  const databaseOnly: ChatMessage[] = []

  for (const message of [...databaseMessages].sort((a, b) => a.timestamp - b.timestamp)) {
    const exactIndex = diskIndexesById.get(message.id)
    if (exactIndex !== undefined) {
      disk[exactIndex] = enrichDiskMessage(disk[exactIndex], message)
      matchedDiskIndexes.add(exactIndex)
      continue
    }
    const key = semanticMessageKey(message)
    const candidates = semanticCandidates.get(key) ?? []
    let cursor = candidateCursor.get(key) ?? 0
    while (cursor < candidates.length && (
      matchedDiskIndexes.has(candidates[cursor].index)
      || candidates[cursor].timestamp < message.timestamp - LEGACY_ID_MATCH_WINDOW_MS
    )) {
      cursor++
    }
    if (cursor < candidates.length && candidates[cursor].timestamp <= message.timestamp + LEGACY_ID_MATCH_WINDOW_MS) {
      const diskIndex = candidates[cursor].index
      disk[diskIndex] = enrichDiskMessage(disk[diskIndex], message)
      matchedDiskIndexes.add(diskIndex)
      candidateCursor.set(key, cursor + 1)
      continue
    }
    candidateCursor.set(key, cursor)
    databaseOnly.push(message)
  }

  return [...disk, ...databaseOnly].sort((a, b) => a.timestamp - b.timestamp)
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    images: message.images?.map((image) => ({ ...image })),
  }
}

function enrichDiskMessage(disk: ChatMessage, database: ChatMessage): ChatMessage {
  const images = mergeImages(disk.images, database.images)
  return {
    ...disk,
    ...(images ? { images } : {}),
    ...(disk.displayBody === undefined && database.displayBody !== undefined
      ? { displayBody: database.displayBody }
      : {}),
    ...(disk.pillsMeta === undefined && database.pillsMeta !== undefined
      ? { pillsMeta: database.pillsMeta }
      : {}),
  }
}

function mergeImages(diskImages: ChatMessage['images'], databaseImages: ChatMessage['images']): ChatMessage['images'] {
  if (!diskImages?.length) return databaseImages?.map((image) => ({ ...image }))
  if (!databaseImages?.length) return diskImages

  const merged = diskImages.map((image) => ({ ...image }))
  const indexesByUrl = new Map(merged.map((image, index) => [image.url, index]))
  for (const databaseImage of databaseImages) {
    const index = indexesByUrl.get(databaseImage.url)
    if (index === undefined) {
      indexesByUrl.set(databaseImage.url, merged.length)
      merged.push({ ...databaseImage })
      continue
    }
    merged[index] = {
      ...databaseImage,
      ...merged[index],
      mimeType: merged[index].mimeType ?? databaseImage.mimeType,
      name: merged[index].name ?? databaseImage.name,
    }
  }
  return merged
}

function semanticMessageKey(message: ChatMessage): string {
  return JSON.stringify([message.role, message.content])
}

/** Fields that decide whether two copies of one id are the same message. */
function sameContent(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role
    && a.content === b.content
    && a.timestamp === b.timestamp
    && (a.toolCalls?.length ?? 0) === (b.toolCalls?.length ?? 0)
}
