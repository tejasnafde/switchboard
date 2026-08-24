import type { ForkLineageMetadata } from '@shared/conversation-fork'
import type { AgentType, ChatMessage } from '@shared/types'
import { useAgentStore } from '../stores/agent-store'

interface LoadedConversation {
  messages: ChatMessage[]
  meta: {
    id: string
    title: string
    projectPath: string
    agentType: string
    rootThreadId?: string
    worktreePath?: string | null
    worktreeBranch?: string | null
    worktreeId?: string | null
    providerInstanceId?: string | null
    runtimeMode?: 'plan' | 'sandbox' | 'accept-edits' | 'full-access' | null
    model?: string | null
    reasoningEffort?: 'low' | 'medium' | 'high' | null
    forkMetadata?: ForkLineageMetadata | null
  } | null
}

function agentType(value: string): AgentType {
  if (value === 'codex' || value === 'opencode' || value === 'terminal') return value
  return 'claude-code'
}

export async function openConversationAtAnchor(metadata: ForkLineageMetadata): Promise<void> {
  const store = useAgentStore.getState()
  const parentId = metadata.parentConversationId
  if (metadata.machineId) window.api.routing.bind(parentId, metadata.machineId)

  if (!store.sessions.some((session) => session.id === parentId)) {
    const loaded = await window.api.app.loadSessionById(parentId) as LoadedConversation
    if (!loaded.meta) throw new Error('The parent conversation is no longer available.')
    store.addSession({
      id: loaded.meta.id,
      type: agentType(loaded.meta.agentType),
      status: 'idle',
      projectPath: loaded.meta.projectPath,
      machineId: metadata.machineId,
      worktreePath: loaded.meta.worktreePath ?? null,
      worktreeBranch: loaded.meta.worktreeBranch ?? null,
      worktreeId: loaded.meta.worktreeId ?? null,
      resumeSessionId: loaded.meta.forkMetadata?.resumeMode === 'transcript-handoff'
        ? undefined
        : loaded.meta.id,
      title: loaded.meta.title,
      runtimeMode: loaded.meta.runtimeMode ?? undefined,
      model: loaded.meta.model ?? undefined,
      reasoningEffort: loaded.meta.reasoningEffort ?? undefined,
      instanceId: loaded.meta.providerInstanceId ?? undefined,
      forkMetadata: loaded.meta.forkMetadata ?? undefined,
    })
    store.setMessages(parentId, loaded.messages)
  }

  store.setActiveSession(parentId)
  store.requestScrollToMessage(parentId, metadata.anchor.messageId)
}
