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
  getConversationModel,
  getConversationProviderInstanceId,
  getConversationRuntimeMode,
  getSetting,
} from '../db/database'
import {
  defaultModelSettingKey,
  resolveSessionDefaults,
  SETTING_DEFAULT_INSTANCE_ID,
  SETTING_DEFAULT_RUNTIME_MODE,
  type ResolvedSessionDefaults,
  type SessionDefaults,
} from '@shared/session-defaults'
import type { AgentType } from '@shared/types'

function machineDefaults(agentType: AgentType): SessionDefaults {
  return {
    runtimeMode: getSetting(SETTING_DEFAULT_RUNTIME_MODE) ?? undefined,
    // Per agent: one global key would hand an OpenCode model to Claude.
    model: getSetting(defaultModelSettingKey(agentType)) ?? undefined,
    instanceId: getSetting(SETTING_DEFAULT_INSTANCE_ID) ?? undefined,
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
    instanceId: getConversationProviderInstanceId(threadId) ?? undefined,
  }
}

export function sessionDefaultsFor(
  threadId: string,
  agentType: AgentType,
  requested: SessionDefaults,
): ResolvedSessionDefaults {
  return resolveSessionDefaults({
    requested,
    conversation: conversationDefaults(threadId, agentType),
    machine: machineDefaults(agentType),
  })
}
