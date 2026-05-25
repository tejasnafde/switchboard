import type { AgentStatus, ChatMessage } from '@shared/types'

/** Returns true when a session's messages should be cleared on switch-away. */
export function shouldEvictMessages(session: {
  status: AgentStatus
  messages: ChatMessage[]
}): boolean {
  return session.status === 'idle' && session.messages.length > 0
}

/** Returns true when a session is in the store but needs messages loaded from disk. */
export function needsMessageReload(session: { messages: ChatMessage[] }): boolean {
  return session.messages.length === 0
}
