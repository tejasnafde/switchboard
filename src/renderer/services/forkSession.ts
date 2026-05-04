/**
 * Fork-from-message orchestration on the renderer side.
 *
 * Calls the main-process IPC, then registers the new session in
 * `agent-store` with the cloned message list pre-loaded so the user
 * sees an exact copy the moment they land in the new tab. The agent's
 * resume primitive (Claude `--resume`, Codex sessionId) is wired via
 * `resumeSessionId` — the chat panel's existing startSession path picks
 * it up the first time the user sends a turn.
 */
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'

export async function forkAndOpenSession(
  sourceConversationId: string,
  upToIndex: number,
  forkedAtMessageId?: string,
): Promise<{ ok: boolean; error?: string; newSessionId?: string; resumable?: boolean }> {
  const res = await window.api.app.forkConversation({
    sourceConversationId,
    upToIndex,
    forkedAtMessageId,
  })
  if (!res.ok) return { ok: false, error: res.error }

  const { conversation, resumeHint, messages, resumable } = res
  const store = useAgentStore.getState()
  // Carry over the source session's runtime mode + model so the fork
  // doesn't silently drop into 'sandbox'/default-model just because it
  // landed in a fresh AgentSession entry. The agent backend resume picks
  // up where the parent left off; the UI controls should match.
  const source = store.sessions.find((s) => s.id === sourceConversationId)
  const type = conversation.agentType === 'codex'
    ? 'codex' as const
    : conversation.agentType === 'opencode'
      ? 'opencode' as const
      : 'claude-code' as const
  store.addSession({
    id: conversation.id,
    type,
    status: 'idle',
    projectPath: conversation.projectPath,
    resumeSessionId: resumeHint ?? undefined,
    title: conversation.title,
    runtimeMode: source?.runtimeMode,
    model: source?.model,
  })
  // For non-resumable forks (Codex / OpenCode today), prepend a synthetic
  // system message so the user knows the new agent process is starting
  // cold and the prior turns are reference-only — without it the fork
  // looks identical to a real resume.
  const decorated = resumable
    ? messages
    : [
        {
          id: `system_fork_notice_${conversation.id}`,
          role: 'system' as const,
          content: `Forked from "${conversation.title.replace(/ · fork$/, '')}" — earlier turns are shown for reference, but ${type === 'codex' ? 'Codex' : type === 'opencode' ? 'OpenCode' : 'this agent'} will start without that context.`,
          timestamp: Date.now(),
        },
        ...messages,
      ]

  store.setMessages(conversation.id, decorated)
  store.setActiveSession(conversation.id)

  // Make sure we're on the chat view (in case the user was looking at
  // kanban). Mirrors what `openSessionByClick` does in App.tsx.
  useLayoutStore.getState().setAppView('chats')

  return { ok: true, newSessionId: conversation.id, resumable }
}
