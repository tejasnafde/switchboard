/**
 * Durable storage for queued messages.
 *
 * One key per message, not one blob holding the queue. A blob means a single
 * malformed write loses every pending message, and it makes concurrent
 * enqueues a read-modify-write race. Per message, a bad entry costs exactly
 * itself and is skipped on load.
 *
 * Written immediately and undebounced, unlike the chat cache. This is user
 * intent, not a copy of something the backend still owns: if the process dies
 * between the composer clearing and the write landing, the message is gone.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLogger } from '@shared/logger'
import type { QueuedMessage } from './outboxModel'

const log = createLogger('mobile:outbox-storage')

const KEY_PREFIX = 'sb-outbox:'

function keyFor(messageId: string): string {
  return `${KEY_PREFIX}${messageId}`
}

/** Shape check rather than a cast: this is parsed from disk written by an
 *  older build, so the fields are not guaranteed. */
function parseQueued(raw: string): QueuedMessage | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const m = value as Partial<QueuedMessage>
    if (
      typeof m.connectionId !== 'string' ||
      typeof m.threadId !== 'string' ||
      typeof m.messageId !== 'string' ||
      typeof m.text !== 'string'
    ) {
      return null
    }
    return {
      connectionId: m.connectionId,
      threadId: m.threadId,
      messageId: m.messageId,
      text: m.text,
      images: Array.isArray(m.images)
        ? m.images.filter((i): i is { url: string; mimeType?: string } =>
            Boolean(i) && typeof (i as { url?: unknown }).url === 'string',
          )
        : undefined,
      runtimeMode: typeof m.runtimeMode === 'string' ? m.runtimeMode : undefined,
      createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
      attempts: typeof m.attempts === 'number' ? m.attempts : 0,
    }
  } catch {
    return null
  }
}

export async function saveQueued(message: QueuedMessage): Promise<void> {
  await AsyncStorage.setItem(keyFor(message.messageId), JSON.stringify(message))
}

export async function removeQueued(messageId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(messageId))
  } catch (err) {
    // A message that is delivered but still on disk would be re-sent on the
    // next launch. The stable messageId is what stops that being a duplicate.
    log.warn('could not remove a delivered message from the outbox', err)
  }
}

/** Everything still queued, oldest first, skipping entries we cannot read. */
export async function loadQueued(): Promise<QueuedMessage[]> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(KEY_PREFIX))
    if (keys.length === 0) return []
    const entries = await AsyncStorage.multiGet(keys)
    const out: QueuedMessage[] = []
    for (const [key, raw] of entries) {
      if (!raw) continue
      const parsed = parseQueued(raw)
      if (parsed) out.push(parsed)
      else {
        log.warn('discarding an unreadable outbox entry')
        void AsyncStorage.removeItem(key)
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  } catch (err) {
    log.warn('could not read the outbox', err)
    return []
  }
}
