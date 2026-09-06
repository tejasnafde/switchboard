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

/**
 * Characters that need no quoting at all in a POSIX shell word. Deliberately
 * conservative: `$`, backtick, quotes, whitespace, `\`, `~`, `*`, `?`, `[`,
 * `!`, `#`, `&`, `;`, `|`, `<`, `>`, `(`, `)`, `{`, `}` are all absent.
 */
const SHELL_SAFE = /^[A-Za-z0-9._/@%+:,=-]+$/

/**
 * POSIX single-quoting: inside `'...'` every byte is literal, so the only
 * thing to escape is the closing quote itself (`'` -> `'\''`). Unlike the
 * double-quoted form this replaced, it leaves NOTHING for the shell to
 * expand - `$(...)`, `${...}`, `$VAR` and backticks in a user-typed
 * oauth_dir are data, not code.
 */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Quote a directory for a copyable shell command.
 *
 * A leading `~/` is expanded to `$HOME` because the tilde is OURS - it comes
 * from the `~/.claude` / `~/.codex` defaults this module generates and from
 * `suggestedOauthDir`, and the command is meant to be pasted on a machine
 * whose home may differ. Nothing else is ever left expandable: the remainder
 * after `~/`, and any other path, is emitted only when it is entirely
 * shell-safe, and single-quoted otherwise.
 *
 * Plain double quotes on a safe path keep the common command readable
 * (`CODEX_HOME="$HOME/.codex-work" codex login`) - with no metacharacter in
 * the string there is nothing for them to fail to protect.
 */
function shellQuotePath(value: string): string {
  if (value === '~' || value === '~/') return '"$HOME"'
  if (value.startsWith('~/')) {
    const rest = value.slice(2)
    return SHELL_SAFE.test(rest) ? `"$HOME/${rest}"` : `"$HOME"/${singleQuote(rest)}`
  }
  return SHELL_SAFE.test(value) ? `"${value}"` : singleQuote(value)
}

/**
 * Public form for callers outside this module that build their own command
 * around a directory (see provider/remote-gate.ts), so there is exactly one
 * quoting implementation to get right.
 */
export function shellQuoteDir(value: string): string {
  return shellQuotePath(value.trim())
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
  return `${envName}=${shellQuotePath(dir)} ${cli}`
}

/**
 * Interactive TUI login (bare CLI + `/login`). Suggested on remote VMs, where
 * the headless `claude auth login` URL+paste flow breaks without a browser.
 */
export function oauthInteractiveLoginCommand(agentType: AgentType, oauthDir: string): string {
  const envName = oauthEnvName(agentType)
  const dir = oauthDir.trim()
  if (!envName || !dir) return ''
  const cli = agentType === 'claude-code' ? 'claude' : 'codex'
  return `${envName}=${shellQuotePath(dir)} ${cli}`
}

export function oauthCreateDirCommand(oauthDir: string): string {
  const dir = oauthDir.trim()
  return dir ? `mkdir -p ${shellQuotePath(dir)}` : ''
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
