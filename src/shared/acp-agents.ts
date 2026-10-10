/**
 * Agents Switchboard drives through the generic Agent Client Protocol
 * adapter, in addition to OpenCode (which uses the same adapter with its own
 * launch config). Each id is both the provider kind on the wire and the
 * agent type stored on a conversation and a provider instance.
 *
 * Adding an agent here also needs a launch config in
 * `src/main/provider/adapters/acp/agents.ts`.
 */

export const GENERIC_ACP_AGENTS = ['gemini', 'vibe', 'cline', 'copilot'] as const

export type GenericAcpAgent = typeof GENERIC_ACP_AGENTS[number]

export function isGenericAcpAgent(value: unknown): value is GenericAcpAgent {
  return typeof value === 'string' && (GENERIC_ACP_AGENTS as readonly string[]).includes(value)
}

export const GENERIC_ACP_AGENT_LABELS: Record<GenericAcpAgent, { label: string; short: string }> = {
  gemini: { label: 'Gemini CLI', short: 'Gemini' },
  vibe: { label: 'Mistral Vibe', short: 'Vibe' },
  cline: { label: 'Cline', short: 'Cline' },
  copilot: { label: 'GitHub Copilot', short: 'Copilot' },
}

/**
 * True for every agent spoken to over ACP, OpenCode included. ACP has one
 * prompt per session at a time: such an agent cannot take a message
 * mid-turn, so a follow-up is queued, never steered.
 */
export function speaksAcp(agent: string | null | undefined): boolean {
  return agent === 'opencode' || isGenericAcpAgent(agent)
}
