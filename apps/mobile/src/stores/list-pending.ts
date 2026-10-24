/**
 * Seeds Needs you for a chat list: asks the backend which cards are open in
 * each of the newest chats, so a chat whose approval opened before this phone
 * was listening still reads Needs you. Live events keep it current after that.
 */
import { createLogger } from '@shared/logger'
import type { SwitchboardClient } from '../lib/api'
import { threadKey, useChatStore } from './chat'

const log = createLogger('store:list-pending')

/** One request per chat, so only the newest few are asked about. */
export const PENDING_SEED_ROWS = 15
const MAX_ATTEMPTS = 3

export async function seedListPendingRequests(
  connectionId: string,
  client: Pick<SwitchboardClient, 'getPendingRequests' | 'supportsCapability'>,
  threadIds: readonly string[],
  /** False once the connection is unpaired or replaced: a late reply must not recreate its state. */
  isCurrent: () => boolean,
): Promise<void> {
  if (client.supportsCapability('pending_requests_v1') !== true) return
  await Promise.all(threadIds.slice(0, PENDING_SEED_ROWS).map((id) => seedOne(connectionId, client, id, isCurrent)))
}

async function seedOne(
  connectionId: string,
  client: Pick<SwitchboardClient, 'getPendingRequests'>,
  threadId: string,
  isCurrent: () => boolean,
): Promise<void> {
  const key = threadKey(connectionId, threadId)
  try {
    // A live event that lands while the backend answers makes the answer
    // stale (it could reopen a card just closed), so ask again.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const revision = useChatStore.getState().pending[key]?.revision ?? 0
      const pending = await client.getPendingRequests(threadId)
      if (!isCurrent()) return
      if (useChatStore.getState().seedPendingRequests(key, pending, revision)) return
    }
    log.warn(`open cards for ${threadId} kept racing live events; keeping the live state`)
  } catch (err) {
    log.warn(`could not read open cards for ${threadId}`, err)
  }
}
