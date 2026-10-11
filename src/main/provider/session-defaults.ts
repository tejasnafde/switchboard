/**
 * Reads the two non-request tiers out of the DB. Split from the pure resolver
 * so the ordering rules test without a database.
 *
 * Both tiers are scoped to the agent being started: nothing clears a stored
 * model on an agent switch, so without scoping a Codex model would pin a later
 * Claude session.
 */
import {
  getConversationAgentType,
  getConversationExecutionRoot,
  getConversationModel,
  getConversationReasoningEffort,
  getConversationProviderInstanceId,
  getConversationRuntimeMode,
  getSetting,
} from '../db/database'
import { getProviderInstanceFull } from '../db/provider-instances'
import { accountStartMode } from '@shared/acp-command'
import { effectiveBackendSetting } from '../project-settings'
import {
  defaultInstanceSettingKey,
  defaultModelSettingKey,
  resolveMachineInstanceId,
  resolveSessionDefaults,
  SETTING_DEFAULT_INSTANCE_ID,
  SETTING_DEFAULT_RUNTIME_MODE,
  type ResolvedSessionDefaults,
  type SessionDefaults,
} from '@shared/session-defaults'
import { defaultInstanceId, type AgentType } from '@shared/types'

function machineDefaults(agentType: AgentType, projectPath: string | null): SessionDefaults {
  const scoped = getSetting(defaultInstanceSettingKey(agentType)) ?? undefined
  const legacy = getSetting(SETTING_DEFAULT_INSTANCE_ID) ?? undefined
  // The legacy key predates per-agent scoping - only honor it while it still
  // names an instance of the agent kind being started, so a Codex pick made
  // through it can never be handed to a Claude/OpenCode session.
  const legacyAgentType = legacy ? (getProviderInstanceFull(legacy)?.agentType ?? null) : null
  return {
    // A project can override the mode its new chats start in.
    runtimeMode: effectiveBackendSetting(SETTING_DEFAULT_RUNTIME_MODE, projectPath),
    // Per agent: one global key would hand an OpenCode model to Claude.
    model: getSetting(defaultModelSettingKey(agentType)) ?? undefined,
    instanceId: resolveMachineInstanceId({ agentType, scoped, legacy, legacyAgentType }),
  }
}

/** Getters route through `resolveRootThreadId`, so a rotated id still finds its
 *  row. `instanceId` stays unscoped - `resolveProviderInstance` guards it. */
function conversationDefaults(threadId: string, agentType: AgentType): SessionDefaults {
  const storedAgent = getConversationAgentType(threadId)
  const sameAgent = storedAgent === null || storedAgent === agentType
  return {
    runtimeMode: getConversationRuntimeMode(threadId) ?? undefined,
    model: sameAgent ? (getConversationModel(threadId) ?? undefined) : undefined,
    reasoningEffort: sameAgent ? (getConversationReasoningEffort(threadId) ?? undefined) : undefined,
    instanceId: getConversationProviderInstanceId(threadId) ?? undefined,
  }
}

/**
 * `cwd` stands in for the project when the conversation row does not exist
 * yet. A worktree chat's row names its parent project, whose overrides it
 * follows.
 */
export function sessionDefaultsFor(
  threadId: string,
  agentType: AgentType,
  requested: SessionDefaults,
  cwd?: string,
): ResolvedSessionDefaults {
  const projectPath = getConversationExecutionRoot(threadId)?.projectPath ?? cwd ?? null
  const tiers = {
    requested,
    conversation: conversationDefaults(threadId, agentType),
    machine: machineDefaults(agentType, projectPath),
  }
  const resolved = resolveSessionDefaults(tiers)
  // The account is known only once the tiers have picked one (else the
  // agent's default row). A stale or wrong-kind id is left for the session
  // start to refuse.
  const account = getProviderInstanceFull(resolved.instanceId ?? defaultInstanceId(agentType), { withEnv: false })
  const startMode = account?.agentType === agentType ? accountStartMode(account.configJson) : null
  return startMode ? resolveSessionDefaults({ ...tiers, account: { runtimeMode: startMode } }) : resolved
}
