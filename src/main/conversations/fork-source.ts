import type { ReasoningEffort } from '../../shared/models'
import { isRuntimeMode, type RuntimeMode } from '../../shared/provider-events'
import { isAgentProvider, type AgentType } from '../../shared/types'
import type { ConversationRow } from '../db/database'

const REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high'])

export interface ForkSourceExecution {
  conversationId: string
  projectPath: string
  sourceCheckoutPath: string
  sourceWorktreePath: string | null
  sourceWorktreeBranch: string | null
  sourceWorktreeId: string | null
  machineId: string
  agentType: Exclude<AgentType, 'terminal'>
  providerSessionId: string | null
  providerInstanceId: string | null
  runtimeMode: RuntimeMode
  model: string | null
  reasoningEffort: ReasoningEffort | null
  launchConfigName: string | null
  title: string
}

type ForkSourceRow = Pick<ConversationRow,
  | 'id'
  | 'project_path'
  | 'agent_type'
  | 'session_id'
  | 'title'
  | 'worktree_path'
  | 'worktree_branch'
  | 'worktree_id'
  | 'provider_instance_id'
  | 'runtime_mode'
  | 'model'
  | 'reasoning_effort'
  | 'launch_config_name'
>

export function projectForkSourceExecution(
  row: ForkSourceRow,
  context: { machineId: string },
): ForkSourceExecution {
  if (!isAgentProvider(row.agent_type)) {
    throw new Error(`fork: unsupported provider ${row.agent_type}`)
  }
  const runtimeMode = row.runtime_mode ?? 'sandbox'
  if (!isRuntimeMode(runtimeMode)) {
    throw new Error(`fork: unsupported runtime mode ${runtimeMode}`)
  }
  const reasoningEffort = row.reasoning_effort ?? null
  if (reasoningEffort !== null && !REASONING_EFFORTS.has(reasoningEffort as ReasoningEffort)) {
    throw new Error(`fork: unsupported reasoning effort ${reasoningEffort}`)
  }

  return {
    conversationId: row.id,
    projectPath: row.project_path,
    sourceCheckoutPath: row.worktree_path ?? row.project_path,
    sourceWorktreePath: row.worktree_path ?? null,
    sourceWorktreeBranch: row.worktree_branch ?? null,
    sourceWorktreeId: row.worktree_id ?? null,
    machineId: context.machineId,
    agentType: row.agent_type,
    providerSessionId: row.session_id ?? null,
    providerInstanceId: row.provider_instance_id ?? null,
    runtimeMode,
    model: row.model ?? null,
    reasoningEffort: reasoningEffort as ReasoningEffort | null,
    launchConfigName: row.launch_config_name ?? null,
    title: row.title,
  }
}
