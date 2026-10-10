/**
 * Launch configs for the agents the generic ACP adapter drives besides
 * OpenCode. Launch commands checked against each agent's docs on
 * 2026-10-08 (none of these CLIs was installed on the machine that wrote
 * this, so none was run):
 *   - Gemini CLI: `gemini --acp` (docs/cli/acp-mode.md; `--experimental-acp`
 *     is the deprecated older spelling)
 *   - Mistral Vibe: `vibe-acp`, a separate binary of the mistral-vibe package
 *     (docs/acp-setup.md)
 *   - Cline: `cline --acp` (docs.cline.bot/usage/acp)
 *   - GitHub Copilot CLI: `copilot --acp`, stdio by default
 *     (docs.github.com, Copilot CLI ACP server reference)
 *
 * None of them is known to name Switchboard's MCP tools in a way the adapter
 * could match safely, so their permission requests for those tools go
 * through the ordinary policy (a card in sandbox mode). Modes come from what
 * `session/new` advertises; models from `models` or a model config option.
 */
import type { GenericAcpAgent } from '@shared/acp-agents'
import { GENERIC_ACP_AGENT_LABELS } from '@shared/acp-agents'
import type { AcpLaunchConfig } from './launch-config'
import { buildAgentEnv, findAgentBinary } from './agent-env'

interface GenericAgentSpec {
  binary: string
  args: string[]
  install: string
  signInHint: string
}

const SPECS: Record<GenericAcpAgent, GenericAgentSpec> = {
  gemini: {
    binary: 'gemini',
    args: ['--acp'],
    install: 'npm install -g @google/gemini-cli',
    signInHint: 'Run `gemini` in a terminal once and sign in, or set GEMINI_API_KEY on this profile, then try again.',
  },
  vibe: {
    binary: 'vibe-acp',
    args: [],
    install: 'uv tool install mistral-vibe',
    signInHint: 'Set MISTRAL_API_KEY on this profile, or run `vibe` in a terminal once, then try again.',
  },
  cline: {
    binary: 'cline',
    args: ['--acp'],
    install: 'npm install -g cline',
    signInHint: 'Run `cline auth` in a terminal, then try again.',
  },
  copilot: {
    binary: 'copilot',
    args: ['--acp'],
    install: 'npm install -g @github/copilot',
    signInHint: 'Run `copilot` in a terminal and sign in with /login, then try again.',
  },
}

export function genericAcpLaunchConfig(agent: GenericAcpAgent): AcpLaunchConfig {
  const spec = SPECS[agent]
  const label = GENERIC_ACP_AGENT_LABELS[agent].label
  return {
    provider: agent,
    label,
    notFoundMessage: `${label} not found (looked for \`${spec.binary}\`). Install: ${spec.install}`,
    signInHint: spec.signInHint,
    modes: { kind: 'advertised' },
    expectedCapabilities: [],
    findBinary: () => findAgentBinary(spec.binary),
    args: () => [...spec.args],
    buildEnv: buildAgentEnv,
    modelLabel: (model) => model.name || model.modelId,
  }
}
