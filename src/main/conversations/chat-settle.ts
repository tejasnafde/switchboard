import type { BackendHost } from '../backend/host'
import { AppChannels } from '@shared/ipc-channels'
import type { ConversationSettledEvent } from '@shared/chat-settle'
import { chatSnoozer } from './chat-snooze'
import { getConversationTitle, resolveRootThreadId, setConversationSettled } from '../db/database'

/**
 * Store a chat's settled time (null unsettles it) and tell every client, so
 * desktops and phones drop or restore the Recents row together. Returns false
 * when the chat has no row.
 */
export function storeConversationSettled(
  host: Pick<BackendHost, 'emit'>,
  id: string,
  settledAt: number | null,
  prNumber?: number,
): boolean {
  if (!setConversationSettled(id, settledAt)) return false
  const event: ConversationSettledEvent = {
    conversationId: resolveRootThreadId(id),
    settledAt,
    title: getConversationTitle(id) ?? undefined,
    ...(prNumber === undefined ? {} : { prNumber }),
  }
  host.emit(AppChannels.CONVERSATION_SETTLED, event)
  if (settledAt !== null) chatSnoozer()?.onCleared(id)
  return true
}
