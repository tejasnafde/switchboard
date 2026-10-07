import { expiredRequestNotice, REQUEST_EXPIRED } from '@shared/provider-events'
import type { ChatMessage } from '@shared/types'
import { useAgentStore } from '../../stores/agent-store'

/**
 * The provider can no longer take an answer for this approval or question
 * (`request.expired`). An open card becomes a notice with the reason, under
 * the same id, so recovery does not bring the card back. An answered card is
 * left as it is.
 */
export function expiredCardUpdate(message: ChatMessage, reason: string): Partial<ChatMessage> | null {
  if (message.approval?.status === 'pending') {
    return { role: 'system', content: expiredRequestNotice('approval', reason), approval: undefined }
  }
  if (message.question?.status === 'pending') {
    return { role: 'system', content: expiredRequestNotice('question', reason), question: undefined }
  }
  return null
}

export function expireRequestCard(threadId: string, requestId: string, reason: string): void {
  const store = useAgentStore.getState()
  const session = store.sessions.find((s) => s.id === threadId)
  for (const id of [`approval_${requestId}`, `question_${requestId}`]) {
    const message = session?.messages.find((m) => m.id === id)
    const update = message && expiredCardUpdate(message, reason)
    if (update) store.updateMessage(threadId, id, update)
  }
}

/** The backend refused an answer because the request expired: close the card too. */
export function expireIfRefused(threadId: string, requestId: string, err: unknown): void {
  if (String(err instanceof Error ? err.message : err).includes(REQUEST_EXPIRED)) {
    expireRequestCard(threadId, requestId, 'The agent is no longer waiting for an answer.')
  }
}
