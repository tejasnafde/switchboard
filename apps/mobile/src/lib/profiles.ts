/**
 * Agent kinds and OAuth-profile selection rules.
 *
 * Pure, and separate from the picker component: anything importing
 * react-native cannot load in a node test.
 */
import type { ProviderKind } from '@shared/provider-events'
import { defaultInstanceId, type AgentType, type ProviderInstance } from '@shared/types'

export const AGENTS: { kind: ProviderKind; label: string; agentType: AgentType }[] = [
  { kind: 'claude', label: 'Claude Code', agentType: 'claude-code' },
  { kind: 'codex', label: 'Codex', agentType: 'codex' },
  { kind: 'opencode', label: 'OpenCode', agentType: 'opencode' },
]

export function agentTypeFor(kind: ProviderKind): AgentType {
  return AGENTS.find((a) => a.kind === kind)?.agentType ?? 'claude-code'
}

/** Enabled profiles for one agent, default first then alphabetical. */
export function profilesFor(instances: ProviderInstance[], kind: ProviderKind): ProviderInstance[] {
  const agentType = agentTypeFor(kind)
  const def = defaultInstanceId(agentType)
  return instances
    .filter((i) => i.agentType === agentType && i.enabled)
    .sort((a, b) => (a.id === def ? 0 : 1) - (b.id === def ? 0 : 1) || a.displayName.localeCompare(b.displayName))
}
