import type { ReasoningEffort } from '../../shared/models'
import type { RuntimeMode } from '../../shared/provider-events'
import type { AgentType } from '../../shared/types'
import type { ConversationRow } from '../db/database'

const FORK_PROVIDERS = new Set<AgentType>(['claude-code', 'codex', 'opencode'])
const RUNTIME_MODES = new Set<RuntimeMode>(['plan', 'sandbox', 'accept-edits', 'full-access'])
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
  if (!FORK_PROVIDERS.has(row.agent_type as AgentType)) {
    throw new Error(`fork: unsupported provider ${row.agent_type}`)
  }
  const runtimeMode = row.runtime_mode ?? 'sandbox'
  if (!RUNTIME_MODES.has(runtimeMode as RuntimeMode)) {
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
    agentType: row.agent_type as ForkSourceExecution['agentType'],
    providerSessionId: row.session_id ?? null,
    providerInstanceId: row.provider_instance_id ?? null,
    runtimeMode: runtimeMode as RuntimeMode,
    model: row.model ?? null,
    reasoningEffort: reasoningEffort as ReasoningEffort | null,
    launchConfigName: row.launch_config_name ?? null,
    title: row.title,
  }
}
