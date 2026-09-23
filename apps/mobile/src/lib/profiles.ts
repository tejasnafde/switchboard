/**
 * Agent kinds and OAuth-profile selection rules.
 *
 * Pure, and separate from the picker component: anything importing
 * react-native cannot load in a node test.
 */
import type { ProviderKind } from '@shared/provider-events'
import { AGENT_PROVIDERS, agentLabel, defaultInstanceId, providerKindFor, toAgentProvider, type AgentType, type ProviderInstance } from '@shared/types'

export const AGENTS: { kind: ProviderKind; label: string; agentType: AgentType }[] = AGENT_PROVIDERS.map((agentType) => ({
  kind: providerKindFor(agentType),
  label: agentLabel(agentType),
  agentType,
}))

export function agentTypeFor(kind: ProviderKind): AgentType {
  return toAgentProvider(kind)
}

/** Enabled profiles for one agent, default first then alphabetical. */
export function profilesFor(instances: ProviderInstance[], kind: ProviderKind): ProviderInstance[] {
  const agentType = agentTypeFor(kind)
  const def = defaultInstanceId(agentType)
  return instances
    .filter((i) => i.agentType === agentType && i.enabled)
    .sort((a, b) => (a.id === def ? 0 : 1) - (b.id === def ? 0 : 1) || a.displayName.localeCompare(b.displayName))
}

/**
 * Back-compat check for `SwitchboardClient.getSessionDefaults`'s machine-
 * default prefill: the pre-scoping global default key names an instance id
 * with no agent kind of its own, so it must only be honored for the agent
 * that instance actually belongs to - never for whichever agent asks next.
 */
export function legacyInstanceBelongsToAgent(
  instances: ProviderInstance[],
  legacyInstanceId: string | undefined,
  agentType: AgentType,
): boolean {
  if (!legacyInstanceId) return false
  return instances.some((i) => i.id === legacyInstanceId && i.agentType === agentType)
}
