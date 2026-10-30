/** Open a parent or child chat, and Nudge: a "To: <child>" chip in the parent's composer. */
import { hubNudgeContent, type HubChatRef } from '@shared/hub'
import { focusComposer } from '../../services/composer-registry'
import { useAgentStore } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { openReviewChat } from '../reviews/review-to-chat'
import { confirm } from '../ui/confirm'

/** The machine of an open chat, under any id of its thread; local when it is not open. */
export function hubMachineOf(chat: HubChatRef): string {
  return useAgentStore.getState().sessions.find((s) => chat.familyIds.includes(s.id))?.machineId ?? 'local'
}

/**
 * Opens the chat the sidebar way (the opener Reviews registers in App);
 * resolves to its session id or null. A parent starts its children on its own
 * backend, so a chat of the hub that is not open lives where `from`, the open
 * one, does.
 */
export const openHubChat = (chat: HubChatRef, from: HubChatRef): Promise<string | null> =>
  openReviewChat(chat, hubMachineOf(from))

export async function nudgeChild(parent: HubChatRef, child: HubChatRef): Promise<void> {
  const sessionId = await openHubChat(parent, child)
  if (!sessionId) return
  const pillId = `hub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const drafts = useDraftStore.getState()
  drafts.addPill(sessionId, {
    id: pillId,
    kind: 'chat-message',
    label: `To: ${child.title}`,
    content: hubNudgeContent(child),
  })
  drafts.appendDraft(sessionId, `[[pill:${pillId}]] `)
  requestAnimationFrame(() => focusComposer(sessionId))
}

/** An archive the backend refused (a chat with child chats waits on its settle card): say why. */
export function showArchiveRefusal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  void confirm({
    title: 'Chat not archived',
    body: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
    confirmLabel: 'OK',
    notice: true,
  })
}
