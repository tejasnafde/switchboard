/**
 * What the Add agent dialog offers, as pure functions: the agent tiles, the
 * sign-in methods per agent, the env rows, the local command form and the
 * account it saves.
 */
import {
  ACP_COMMAND_AGENT,
  BUILT_IN_ACP_AGENTS,
  GENERIC_ACP_AGENT_INSTALL,
  isGenericAcpAgent,
} from '@shared/acp-agents'
import { splitCommandArgs, type AcpCommandConfig } from '@shared/acp-command'
import { agentLabel, type AgentProvider, type ProviderInstance } from '@shared/types'
import { oauthLoginCommand, suggestedOauthDir } from '@shared/provider-auth-format'
import type { ProviderInstanceUpsertInput } from '../../../preload'

/** The agents the dialog lists as tiles, in order. A local command is its own path. */
export const ADD_AGENT_KINDS: readonly AgentProvider[] = ['claude-code', 'codex', 'opencode', ...BUILT_IN_ACP_AGENTS]

export const ADD_AGENT_STEPS = [
  { id: 'agent', label: 'Agent' },
  { id: 'sign-in', label: 'Sign-in' },
  { id: 'config', label: 'Config' },
] as const

export type AddAgentStep = (typeof ADD_AGENT_STEPS)[number]['id']

const INSTALL: Partial<Record<AgentProvider, string>> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'npm install -g opencode-ai',
  ...GENERIC_ACP_AGENT_INSTALL,
}

export function installCommand(kind: AgentProvider): string | null {
  return INSTALL[kind] ?? null
}

/** Claude Code, Codex and OpenCode are run with Switchboard every day; the rest are not. */
export function isTestedAgent(kind: AgentProvider): boolean {
  return !isGenericAcpAgent(kind)
}

/** The tile's second line: why it cannot be picked, or how many accounts it has. */
export function agentTileStatus(installed: boolean | undefined, accounts: number): string {
  if (installed === undefined) return 'Checking…'
  if (!installed) return 'Not installed'
  if (accounts > 0) return `${accounts} account${accounts === 1 ? '' : 's'}`
  return 'Installed'
}

/** The tile names, short where the full one would not fit a quarter of the dialog. */
const TILE_LABEL: Partial<Record<AgentProvider, string>> = { vibe: 'Vibe', copilot: 'Copilot' }

export function agentTileLabel(kind: AgentProvider): string {
  return TILE_LABEL[kind] ?? agentLabel(kind)
}

const AGENT_INITIALS: Record<AgentProvider, string> = {
  'claude-code': 'CC',
  codex: 'CX',
  opencode: 'OC',
  gemini: 'GC',
  vibe: 'MV',
  cline: 'CL',
  copilot: 'GH',
  [ACP_COMMAND_AGENT]: 'LC',
}

/** The avatar letters: the agent's own, or a local command account's from its name. */
export function avatarInitials(kind: AgentProvider, name: string): string {
  return kind === ACP_COMMAND_AGENT && name ? agentInitials(name) : AGENT_INITIALS[kind]
}

/** Two letters for a name ("Kestrel Review" -> "KR", "Kestrel" -> "KE"). */
export function agentInitials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : label.slice(0, 2)
  return letters.toUpperCase()
}

/**
 * How an account signs in.
 * - `folder`: a login folder of its own (CLAUDE_CONFIG_DIR / CODEX_HOME),
 *   signed into once with the CLI's login command.
 * - `key`: one API key, stored encrypted in the account's env.
 * - `terminal`: the CLI keeps its own sign-in, made once in a terminal and
 *   shared by every account of that agent.
 * - `env`: any env vars the agent reads.
 */
export type SignInMethod =
  | { id: 'folder'; label: string }
  | { id: 'key'; label: string; envKey: string }
  | { id: 'terminal'; label: string; command: string; hint?: string }
  | { id: 'env'; label: string; hint: string }

export function signInMethods(kind: AgentProvider): SignInMethod[] {
  switch (kind) {
    case 'claude-code':
      return [
        { id: 'folder', label: 'Claude account' },
        { id: 'key', label: 'API key', envKey: 'ANTHROPIC_API_KEY' },
      ]
    case 'codex':
      return [
        { id: 'folder', label: 'ChatGPT account' },
        { id: 'key', label: 'API key', envKey: 'OPENAI_API_KEY' },
      ]
    case 'opencode':
      return [{ id: 'env', label: 'API keys', hint: 'The provider keys OpenCode reads, such as OPENROUTER_API_KEY.' }]
    case 'gemini':
      return [
        { id: 'terminal', label: 'Google account', command: 'gemini' },
        { id: 'key', label: 'API key', envKey: 'GEMINI_API_KEY' },
      ]
    case 'vibe':
      return [
        { id: 'key', label: 'API key', envKey: 'MISTRAL_API_KEY' },
        { id: 'terminal', label: 'Mistral account', command: 'vibe' },
      ]
    case 'cline':
      return [{ id: 'terminal', label: 'Cline account', command: 'cline auth' }]
    case 'copilot':
      return [{ id: 'terminal', label: 'GitHub account', command: 'copilot', hint: 'Then type /login.' }]
    case ACP_COMMAND_AGENT:
      return [{ id: 'env', label: 'Environment variables', hint: 'Add any keys it needs. They are stored encrypted.' }]
  }
}

/** The command the sign-in step shows for a folder method. */
export function folderLoginCommand(kind: AgentProvider, folder: string): string {
  return oauthLoginCommand(kind, folder)
}

/** "Claude Code Work" -> `~/.claude-work`: the folder already names the agent. */
export function defaultSignInFolder(kind: AgentProvider, name: string): string {
  const label = agentLabel(kind).toLowerCase()
  const trimmed = name.trim()
  const rest = trimmed.toLowerCase().startsWith(`${label} `) ? trimmed.slice(label.length + 1) : trimmed
  return suggestedOauthDir(kind, rest || 'work')
}

export interface EnvRow {
  key: string
  value: string
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The rows as an env map. Empty rows are skipped; a row with a bad name is an error. */
export function envFromRows(rows: readonly EnvRow[]): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    if (!ENV_KEY.test(key)) return { error: `"${key || '(empty)'}" is not a variable name.` }
    env[key] = row.value
  }
  return { env }
}

export interface LocalCommandForm {
  command: string
  args: string
  cwd: string
}

/** The launch config the local command form describes, or the first problem with it. */
export function localCommandConfig(form: LocalCommandForm): { config: AcpCommandConfig } | { error: string } {
  const command = form.command.trim()
  if (!command) return { error: 'Enter the command that starts the agent.' }
  const args = splitCommandArgs(form.args)
  if (!args) return { error: 'A quote in the arguments is not closed.' }
  return { config: { command, args, cwd: form.cwd.trim() || null } }
}

/** The name a local command account gets until the user picks one ("kestrel-acp" -> "Kestrel Acp"). */
export function nameFromCommand(command: string): string {
  const base =
    command
      .trim()
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[a-z]+$/i, '') ?? ''
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/** A suggested name for a new account of this agent that no account of it uses yet. */
export function suggestedName(kind: AgentProvider, instances: readonly ProviderInstance[], base?: string): string {
  const stem = base || `${agentLabel(kind)} Work`
  const taken = new Set(instances.filter((i) => i.agentType === kind).map((i) => i.displayName.toLowerCase()))
  if (!taken.has(stem.toLowerCase())) return stem
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`
}

export function nameTaken(kind: AgentProvider, name: string, instances: readonly ProviderInstance[]): boolean {
  const wanted = name.trim().toLowerCase()
  return instances.some((i) => i.agentType === kind && i.displayName.toLowerCase() === wanted)
}

export interface AddAgentDraft {
  kind: AgentProvider
  method: SignInMethod
  folder: string
  key: string
  envRows: readonly EnvRow[]
  launch: AcpCommandConfig | null
}

/** The credentials part of an account, shared by the Test probe and the save. */
export function draftCredentials(draft: AddAgentDraft): Pick<
  ProviderInstanceUpsertInput,
  'agentType' | 'env' | 'oauthDir' | 'configJson'
> & {
  authMode: 'env' | 'oauth_dir'
} {
  const base = { agentType: draft.kind, configJson: draft.launch ? { launch: draft.launch } : undefined }
  switch (draft.method.id) {
    case 'folder':
      return { ...base, authMode: 'oauth_dir', oauthDir: draft.folder.trim() || null, env: null }
    case 'key':
      return { ...base, authMode: 'env', env: draft.key ? { [draft.method.envKey]: draft.key } : {}, oauthDir: null }
    case 'env': {
      const parsed = envFromRows(draft.envRows)
      return { ...base, authMode: 'env', env: 'env' in parsed ? parsed.env : {}, oauthDir: null }
    }
    case 'terminal':
      return { ...base, authMode: 'env', env: {}, oauthDir: null }
  }
}

/** The account to save. An untested agent's new chats start in plan mode. */
export function addAgentInput(
  draft: AddAgentDraft,
  config: { name: string; accentColor: string },
): ProviderInstanceUpsertInput {
  const credentials = draftCredentials(draft)
  const startMode = isTestedAgent(draft.kind) ? {} : { startMode: 'plan' }
  const configJson = { ...((credentials.configJson as object | undefined) ?? {}), ...startMode }
  return {
    ...credentials,
    displayName: config.name.trim(),
    accentColor: config.accentColor,
    configJson: Object.keys(configJson).length > 0 ? configJson : undefined,
    enabled: true,
  }
}

/** Avatar tint per agent, in each product's own colour. */
export const AGENT_AVATAR_CLASS: Record<AgentProvider, string> = {
  'claude-code': 'bg-[#d97757]',
  codex: 'bg-[#3d7bff]',
  opencode: 'bg-[#6b7280]',
  gemini: 'bg-[#4f8df7]',
  vibe: 'bg-[#ff7000]',
  cline: 'bg-[#7c5cff]',
  copilot: 'bg-[#8b949e]',
  [ACP_COMMAND_AGENT]: 'bg-[#2f9e8f]',
}

export const ACCENT_PALETTE = ['#ff8a3d', '#3da8ff', '#7c5cff', '#3dd17a', '#ff5ca8', '#ffd23d'] as const
