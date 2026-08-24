import type { ForkLineageMetadata } from '@shared/conversation-fork'
import type { AgentType } from '@shared/types'
import type { RuntimeMode } from '../stores/agent-store'

export interface LoadedSearchSessionMeta {
  id: string
  title: string
  projectPath: string
  agentType: string
  rootThreadId?: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  worktreeId?: string | null
  providerInstanceId?: string | null
  runtimeMode?: RuntimeMode | null
  model?: string | null
  reasoningEffort?: 'low' | 'medium' | 'high' | null
  forkMetadata?: ForkLineageMetadata | null
}

function toAgentType(value: string): AgentType {
  if (value === 'codex' || value === 'opencode' || value === 'terminal') return value
  return 'claude-code'
}

export function projectLoadedSearchSession(meta: LoadedSearchSessionMeta) {
  return {
    id: meta.id,
    type: toAgentType(meta.agentType),
    status: 'idle' as const,
    projectPath: meta.projectPath,
    worktreePath: meta.worktreePath ?? null,
    worktreeBranch: meta.worktreeBranch ?? null,
    worktreeId: meta.worktreeId ?? null,
    resumeSessionId: meta.forkMetadata?.resumeMode === 'transcript-handoff'
      ? undefined
      : meta.id,
    title: meta.title,
    runtimeMode: meta.runtimeMode ?? undefined,
    model: meta.model ?? undefined,
    reasoningEffort: meta.reasoningEffort ?? undefined,
    instanceId: meta.providerInstanceId ?? undefined,
    forkMetadata: meta.forkMetadata ?? undefined,
  }
}
