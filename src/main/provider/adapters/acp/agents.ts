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
import { ACP_COMMAND_AGENT, GENERIC_ACP_AGENT_INSTALL, GENERIC_ACP_AGENT_LABELS } from '@shared/acp-agents'
import { acpCommandConfig, type AcpCommandConfig } from '@shared/acp-command'
import { expandTilde, getProviderInstanceFull } from '../../../db/provider-instances'
import type { AcpLaunchConfig } from './launch-config'
import { buildAgentEnv, findAgentBinary, resolveAgentCommand } from './agent-env'

interface GenericAgentSpec {
  binary: string
  args: string[]
  signInHint: string
}

const SPECS: Record<Exclude<GenericAcpAgent, typeof ACP_COMMAND_AGENT>, GenericAgentSpec> = {
  gemini: {
    binary: 'gemini',
    args: ['--acp'],
    signInHint: 'Run `gemini` in a terminal once and sign in, or set GEMINI_API_KEY on this profile, then try again.',
  },
  vibe: {
    binary: 'vibe-acp',
    args: [],
    signInHint: 'Set MISTRAL_API_KEY on this profile, or run `vibe` in a terminal once, then try again.',
  },
  cline: {
    binary: 'cline',
    args: ['--acp'],
    signInHint: 'Run `cline auth` in a terminal, then try again.',
  },
  copilot: {
    binary: 'copilot',
    args: ['--acp'],
    signInHint: 'Run `copilot` in a terminal and sign in with /login, then try again.',
  },
}

export function genericAcpLaunchConfig(agent: GenericAcpAgent): AcpLaunchConfig {
  if (agent === ACP_COMMAND_AGENT) return ACP_COMMAND_LAUNCH
  const spec = SPECS[agent]
  const label = GENERIC_ACP_AGENT_LABELS[agent].label
  return {
    provider: agent,
    label,
    notFoundMessage: `${label} not found (looked for \`${spec.binary}\`). Install: ${GENERIC_ACP_AGENT_INSTALL[agent]}`,
    signInHint: spec.signInHint,
    modes: { kind: 'advertised' },
    expectedCapabilities: [],
    findBinary: () => findAgentBinary(spec.binary),
    args: () => [...spec.args],
    buildEnv: buildAgentEnv,
    modelLabel: (model) => model.name || model.modelId,
  }
}

function accountCommand(instanceId: string | null | undefined): AcpCommandConfig | null {
  if (!instanceId) return null
  return acpCommandConfig(getProviderInstanceFull(instanceId, { withEnv: false })?.configJson)
}

/**
 * A local command: whatever program the account's launch config names,
 * started with its own arguments. Nothing about it is known in advance, so
 * it gets the plain ACP behaviour of the other generic agents. Without an
 * account it is never "installed".
 */
const ACP_COMMAND_LAUNCH: AcpLaunchConfig = {
  provider: ACP_COMMAND_AGENT,
  label: GENERIC_ACP_AGENT_LABELS[ACP_COMMAND_AGENT].label,
  notFoundMessage:
    'The command of this account was not found. Check it in Settings > Accounts, or add the agent again with the right path.',
  signInHint: 'Add the keys the agent needs to this account in Settings > Accounts, then try again.',
  modes: { kind: 'advertised' },
  expectedCapabilities: [],
  findBinary: (instanceId) => {
    const launch = accountCommand(instanceId)
    return launch ? resolveAgentCommand(launch.command) : null
  },
  args: (_cwd, instanceId) => [...(accountCommand(instanceId)?.args ?? [])],
  spawnCwd: (instanceId) => expandTilde(accountCommand(instanceId)?.cwd ?? null),
  buildEnv: buildAgentEnv,
  modelLabel: (model) => model.name || model.modelId,
}
