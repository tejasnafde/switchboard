/**
 * Remote-machine helpers for the provider registry.
 *
 * Two concerns live here, both pure enough to unit-test:
 *   1. Gating Codex / OpenCode off remote machines (only Claude Code runs on
 *      remote VMs today).
 *   2. Detecting when a remote Claude session's config dir has no credentials
 *      and building the actionable per-device-login prompt shown in chat.
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { oauthInteractiveLoginCommand } from '@shared/provider-auth-format'
import type { ProviderKind } from './types'

/**
 * Human label for a provider that isn't available on remote machines yet, or
 * null when it is (Claude). Drives both the hard-deny at session start and the
 * IS_AVAILABLE gray-out.
 */
export function remoteBlockedProviderLabel(provider: ProviderKind): string | null {
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return null
}

/**
 * Pure: format the per-device-login prompt for a remote Claude session that
 * has no credentials. Deliberately suggests the interactive TUI + `/login`,
 * not `claude auth login` - the headless URL+paste flow breaks on a VM.
 */
export function formatRemoteClaudeLoginPrompt(cmd: string): string {
  const command = cmd.trim() || 'claude'
  return `This machine is not logged in to Claude. Open a terminal on it and run:\n\n    ${command}\n\nThen sign in with /login - open the URL it prints in your local browser and paste the code back into the same terminal (keep it running). Once signed in, send your message again.`
}

/** True if the dir holds a NON-EMPTY .credentials.json (an interrupted or
 *  touched login can leave a zero-byte file that would falsely read as ready). */
function hasCredentials(configDir: string): boolean {
  try {
    return statSync(join(configDir, '.credentials.json')).size > 0
  } catch {
    return false
  }
}

/**
 * Structured result of the proactive remote-auth preflight. Unlike
 * `remoteClaudeLoginPrompt` (a prose backstop thrown at START_SESSION), this
 * feeds the renderer's chat-open banner, so it carries the raw pieces - the
 * verdict, the copyable login command, and the dir that was checked.
 */
export interface RemoteClaudeAuthCheck {
  loggedIn: boolean
  loginCommand: string
  configDir: string
}

/**
 * Pure check: is a remote Claude session rooted at `configDir` able to
 * authenticate? Same signals as `remoteClaudeLoginPrompt` (non-empty
 * `.credentials.json`, or `ANTHROPIC_API_KEY` in the env), but returns
 * structured data instead of a prose prompt.
 */
export function checkRemoteClaudeAuth(configDir: string): RemoteClaudeAuthCheck {
  const loggedIn = Boolean(process.env.ANTHROPIC_API_KEY) || hasCredentials(configDir)
  return {
    loggedIn,
    loginCommand: oauthInteractiveLoginCommand('claude-code', configDir) || 'claude',
    configDir,
  }
}

/**
 * Decide whether a remote Claude session can authenticate from `configDir`.
 * Returns null when it's logged in (a non-empty `.credentials.json` exists in
 * the dir, or `ANTHROPIC_API_KEY` is set); otherwise returns the actionable
 * per-device-login message to surface in chat.
 */
export function remoteClaudeLoginPrompt(configDir: string): string | null {
  if (process.env.ANTHROPIC_API_KEY) return null
  if (hasCredentials(configDir)) return null
  const cmd = oauthInteractiveLoginCommand('claude-code', configDir)
  return formatRemoteClaudeLoginPrompt(cmd)
}

/**
 * Pure: coerce a forwarded config-dir name into a single safe path segment.
 * The desktop sends the basename of a local oauth_dir (e.g. `.claude-akshaya`);
 * because it crosses the wire we treat it as untrusted and strip anything that
 * could escape `$HOME` (path separators, `..`, control chars). Anything except
 * `[A-Za-z0-9._-]` is removed; an empty result or a `.`/`..` segment falls back
 * to `.claude`.
 */
export function sanitizeConfigSegment(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return '.claude'
  return cleaned
}

/**
 * List every `~/.claude*` dir on a remote VM. Sessions run under forwarded
 * per-instance config dirs the VM's provider_instances table doesn't know
 * about; forwarded dirs are always single segments under $HOME (see
 * sanitizeConfigSegment), so a shallow readdir covers every candidate.
 */
export function listRemoteClaudeConfigDirs(home: string = homedir()): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((e) => e.name.startsWith('.claude') && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => join(home, e.name))
      .filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
  } catch {
    return []
  }
}

/**
 * Resolve the absolute Claude config dir for a remote session from the
 * forwarded dir name, always under the VM's own `$HOME`. Falsy input (no
 * instance / env-mode instance) returns `~/.claude`. The name is sanitized to
 * a single segment first so a hostile payload can't traverse out of `$HOME`.
 */
export function remoteClaudeConfigDir(remoteConfigDir: string | undefined): string {
  if (!remoteConfigDir) return join(homedir(), '.claude')
  return join(homedir(), sanitizeConfigSegment(remoteConfigDir))
}
