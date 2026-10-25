/** Open a parent or child chat, and Nudge: a "To: <child>" chip in the parent's composer. */
import { hubNudgeContent, type HubChatRef } from '@shared/hub'
import { focusComposer } from '../../services/composer-registry'
import { useDraftStore } from '../../stores/draft-store'
import { openReviewChat } from '../reviews/review-to-chat'

/** Opens the chat the sidebar way (the opener Reviews registers in App); resolves to its session id or null. */
export const openHubChat = (chat: HubChatRef): Promise<string | null> => openReviewChat(chat)

export async function nudgeChild(parent: HubChatRef, child: HubChatRef): Promise<void> {
  const sessionId = await openHubChat(parent)
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
