import type { AgentType } from './types'

export interface FormattedAuthStatus {
  ok: boolean
  message: string
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\`])/g, '\\$1')}"`
}

function commandPath(value: string): string {
  if (value.startsWith('~/')) return `$HOME/${value.slice(2)}`
  return value
}

export function oauthEnvName(agentType: AgentType): string | null {
  if (agentType === 'claude-code') return 'CLAUDE_CONFIG_DIR'
  if (agentType === 'codex') return 'CODEX_HOME'
  return null
}

export function suggestedOauthDir(agentType: AgentType, displayName: string): string {
  const slug = slugify(displayName) || 'work'
  if (agentType === 'claude-code') return `~/.claude-${slug}`
  if (agentType === 'codex') return `~/.codex-${slug}`
  return `~/.${slug}`
}

export function oauthLoginCommand(agentType: AgentType, oauthDir: string): string {
  const envName = oauthEnvName(agentType)
  const dir = oauthDir.trim()
  if (!envName || !dir) return ''
  const cli = agentType === 'claude-code' ? 'claude auth login' : 'codex login'
  return `${envName}=${shellQuote(commandPath(dir))} ${cli}`
}

export function oauthCreateDirCommand(oauthDir: string): string {
  const dir = oauthDir.trim()
  return dir ? `mkdir -p ${shellQuote(commandPath(dir))}` : ''
}

export function formatClaudeAuthStatus(stdout: string, oauthDir?: string | null): FormattedAuthStatus {
  const trimmed = stdout.trim()
  if (!trimmed) return { ok: true, message: 'Logged in to Claude Code.' }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const loggedIn = parsed.loggedIn === true
    if (!loggedIn) {
      const command = oauthLoginCommand('claude-code', oauthDir || '~/.claude')
      return {
        ok: false,
        message: command
          ? `Not logged in. Run: ${command}`
          : 'Not logged in to Claude Code.',
      }
    }

    const email = typeof parsed.email === 'string' ? parsed.email : null
    const orgName = typeof parsed.orgName === 'string' ? parsed.orgName : null
    const subscriptionType = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : null
    const provider = typeof parsed.apiProvider === 'string' ? parsed.apiProvider : null
    const parts = [
      email ? `Account: ${email}` : 'Logged in',
      orgName ? `Org: ${orgName}` : null,
      subscriptionType ? `Plan: ${subscriptionType}` : null,
      authMethod || provider ? `Auth: ${[authMethod, provider].filter(Boolean).join(' / ')}` : null,
    ].filter((part): part is string => Boolean(part))

    return { ok: true, message: parts.join(' | ') }
  } catch {
    return { ok: true, message: trimmed }
  }
}
