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

/**
 * Which store session a click should activate. The sidebar lists a chat under
 * its SDK session UUID, but a live adapter keys events to the synthetic
 * `agent_<ts>` thread, so activating the UUID built a second store session and
 * the stream rendered where nothing was visible. Falls back to the clicked id,
 * which is what a fresh open after restart needs.
 */
export function resolveSessionSelectTarget(
  clickedId: string,
  rootThreadId: string | undefined,
  storeSessionIds: readonly string[],
): string {
  if (!rootThreadId || rootThreadId === clickedId) return clickedId
  return storeSessionIds.includes(rootThreadId) ? rootThreadId : clickedId
}
