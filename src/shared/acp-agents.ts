/**
 * Agents Switchboard drives through the generic Agent Client Protocol
 * adapter, in addition to OpenCode (which uses the same adapter with its own
 * launch config). Each id is both the provider kind on the wire and the
 * agent type stored on a conversation and a provider instance.
 *
 * Adding an agent here also needs a launch config in
 * `src/main/provider/adapters/acp/agents.ts`.
 */

export const GENERIC_ACP_AGENTS = ['gemini', 'vibe', 'cline', 'copilot', 'acp-command'] as const

export type GenericAcpAgent = (typeof GENERIC_ACP_AGENTS)[number]

export function isGenericAcpAgent(value: unknown): value is GenericAcpAgent {
  return typeof value === 'string' && (GENERIC_ACP_AGENTS as readonly string[]).includes(value)
}

export const GENERIC_ACP_AGENT_LABELS: Record<GenericAcpAgent, { label: string; short: string }> = {
  gemini: { label: 'Gemini CLI', short: 'Gemini' },
  vibe: { label: 'Mistral Vibe', short: 'Vibe' },
  cline: { label: 'Cline', short: 'Cline' },
  copilot: { label: 'GitHub Copilot', short: 'Copilot' },
  'acp-command': { label: 'Local command', short: 'Local' },
}

/**
 * The agent whose command, arguments and folder come from each account's
 * launch config (`shared/acp-command.ts`) instead of a fixed binary. It has
 * no seeded default account: every account of it is one the user added.
 */
export const ACP_COMMAND_AGENT = 'acp-command' satisfies GenericAcpAgent

/** Generic agents with a fixed binary, in the order Settings lists them. */
export const BUILT_IN_ACP_AGENTS = GENERIC_ACP_AGENTS.filter(
  (agent): agent is Exclude<GenericAcpAgent, typeof ACP_COMMAND_AGENT> => agent !== ACP_COMMAND_AGENT,
)

/** How to install each built-in generic agent's CLI. */
export const GENERIC_ACP_AGENT_INSTALL: Record<(typeof BUILT_IN_ACP_AGENTS)[number], string> = {
  gemini: 'npm install -g @google/gemini-cli',
  vibe: 'uv tool install mistral-vibe',
  cline: 'npm install -g cline',
  copilot: 'npm install -g @github/copilot',
}

/**
 * True for every agent spoken to over ACP, OpenCode included. ACP has one
 * prompt per session at a time: such an agent cannot take a message
 * mid-turn, so a follow-up is queued, never steered.
 */
export function speaksAcp(agent: string | null | undefined): boolean {
  return agent === 'opencode' || isGenericAcpAgent(agent)
}
