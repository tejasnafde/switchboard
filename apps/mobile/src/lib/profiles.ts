/**
 * Agent kinds and OAuth-profile selection rules.
 *
 * Pure, and separate from the picker component: anything importing
 * react-native cannot load in a node test.
 */
import type { ProviderKind } from '@shared/provider-events'
import { isGenericAcpAgent } from '@shared/acp-agents'
import { AGENT_PROVIDERS, agentLabel, defaultInstanceId, providerKindFor, toAgentProvider, type AgentType, type ProviderInstance } from '@shared/types'

type AgentChoice = { kind: ProviderKind; label: string; agentType: AgentType }

function agentChoice(agentType: AgentType): AgentChoice {
  return { kind: providerKindFor(agentType), label: agentLabel(agentType), agentType }
}

/**
 * Agents a phone offers. The generic ACP agents (Gemini CLI, Vibe, Cline,
 * Copilot) are staged on phones (flag mobile_generic_acp_agents): a phone
 * shows and continues their chats but does not start or switch to them.
 */
export const AGENTS: AgentChoice[] = AGENT_PROVIDERS.filter((agentType) => !isGenericAcpAgent(agentType)).map(agentChoice)

/** The offered agents, plus the chat's own agent when it is one of the staged ones. */
export function agentsFor(current: ProviderKind): AgentChoice[] {
  return isGenericAcpAgent(current) ? [...AGENTS, agentChoice(current)] : AGENTS
}

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
