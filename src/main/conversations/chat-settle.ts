import type { BackendHost } from '../backend/host'
import { AppChannels } from '@shared/ipc-channels'
import type { ConversationSettledEvent } from '@shared/chat-settle'
import { chatSnoozer } from './chat-snooze'
import {
  getConversationSnooze,
  getConversationTitle,
  resolveRootThreadId,
  setConversationSettled,
} from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('conversations:settle')

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
  const snooze = settledAt === null ? null : getConversationSnooze(id)
  if (!setConversationSettled(id, settledAt)) return false
  // The revision after this write, so the Undo's snooze is refused once the chat moved on.
  const rev = snooze?.snoozedAt != null ? getConversationSnooze(id)?.snoozeRev : undefined
  const event: ConversationSettledEvent = {
    conversationId: resolveRootThreadId(id),
    settledAt,
    title: getConversationTitle(id) ?? undefined,
    ...(prNumber === undefined ? {} : { prNumber }),
    ...(snooze && rev !== undefined ? { endedSnooze: { until: snooze.snoozedUntil, pr: snooze.snoozePr, rev } } : {}),
  }
  host.emit(AppChannels.CONVERSATION_SETTLED, event)
  // The settle is stored and sent; a failed snooze broadcast must not undo it on the caller.
  if (settledAt !== null) {
    try {
      chatSnoozer()?.onCleared(id)
    } catch (err) {
      log.warn(`snooze cleanup after the settle of ${id} failed`, err)
    }
  }
  return true
}
