import { useAgentStore } from '../../stores/agent-store'

export const PROVIDER_RETRY_MESSAGE_ID = 'provider_retry'

export function upsertProviderRetry(threadId: string, message: string): void {
  const store = useAgentStore.getState()
  const progress = message.match(/\b\d+\/\d+\b/)?.[0]
  const content = `Codex disconnected · retrying${progress ? ` ${progress}` : ''}`
  const exists = store.sessions.find((session) => session.id === threadId)
    ?.messages.some((entry) => entry.id === PROVIDER_RETRY_MESSAGE_ID)
  if (exists) store.updateMessage(threadId, PROVIDER_RETRY_MESSAGE_ID, { content })
  else store.appendMessage(threadId, {
    id: PROVIDER_RETRY_MESSAGE_ID,
    role: 'system',
    content,
    timestamp: Date.now(),
  })
}

export function clearProviderRetry(threadId: string): void {
  useAgentStore.getState().removeMessage(threadId, PROVIDER_RETRY_MESSAGE_ID)
}
