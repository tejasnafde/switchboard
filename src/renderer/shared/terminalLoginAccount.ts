/**
 * Pure account-selection helpers for the Terminal-tab "Account" list in
 * UnifiedProviderPicker.tsx.
 *
 * `resolveVisibleLoginInstanceId` mirrors main's
 * `resolveProviderInstance` fallback order (see
 * src/main/db/providerInstances.ts) - canonical `${kind}-default` id
 * first, then the oldest enabled instance - so the Account row the user
 * sees highlighted is always the exact instance main will spawn against
 * when no explicit pick has been made. `instances` must already be
 * filtered to the requested agent kind and to enabled rows only (as the
 * `loginInstances` list in UnifiedProviderPicker.tsx is).
 *
 * `nextTermInstanceId` keys the selected instance id to the login agent
 * kind derived from the CLI binary: a Codex instance id must never
 * survive a switch to Claude (or to a custom command), which would
 * otherwise get sent as identity for the wrong kind.
 */
import { defaultInstanceId, type AgentType } from '@shared/types'

export type LoginAgentType = 'claude-code' | 'codex' | null

export function resolveVisibleLoginInstanceId(
  instances: Array<{ id: string; createdAt: number }>,
  agentType: AgentType,
  requestedId: string | undefined,
): string | undefined {
  if (requestedId && instances.some((i) => i.id === requestedId)) {
    return requestedId
  }
  const canonicalId = defaultInstanceId(agentType)
  if (instances.some((i) => i.id === canonicalId)) {
    return canonicalId
  }
  let oldest: { id: string; createdAt: number } | undefined
  for (const inst of instances) {
    if (!oldest || inst.createdAt < oldest.createdAt) oldest = inst
  }
  return oldest?.id
}

export function nextTermInstanceId(
  prevLoginAgentType: LoginAgentType,
  nextLoginAgentType: LoginAgentType,
  currentTermInstanceId: string | undefined,
): string | undefined {
  if (prevLoginAgentType === nextLoginAgentType) return currentTermInstanceId
  return undefined
}
