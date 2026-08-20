/**
 * Durable storage for queued messages. One key per message, not one blob: a
 * blob loses every pending message to one bad write and makes concurrent
 * enqueues a read-modify-write race.
 *
 * Written immediately, unlike the chat cache. This is user intent, not a copy
 * of something the backend still owns.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLogger } from '@shared/logger'
import { parseQueuedMessage, type QueuedMessage } from './outboxModel'

const log = createLogger('mobile:outbox-storage')

const KEY_PREFIX = 'sb-outbox:'

function keyFor(messageId: string): string {
  return `${KEY_PREFIX}${messageId}`
}

function parseQueued(raw: string): QueuedMessage | null {
  try {
    return parseQueuedMessage(JSON.parse(raw))
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
    // A delivered message left on disk is re-sent next launch; the stable
    // messageId is what stops that being a duplicate.
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
