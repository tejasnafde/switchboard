/**
 * Remote-machine helpers for the provider registry.
 *
 * Two concerns live here, both pure enough to unit-test:
 *   1. Gating unsupported providers off remote machines.
 *   2. Detecting missing remote provider credentials and building the
 *      actionable per-device-login prompt shown in chat.
 */

import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { oauthInteractiveLoginCommand, shellQuoteDir } from '@shared/provider-auth-format'
import { createMainLogger } from '../logger'
import { managedPath } from './managed-bin'
import type { ProviderKind } from './types'
import type { AgentType } from '@shared/types'

const log = createMainLogger('provider:remote-gate')

/**
 * Human label for a provider that isn't available on remote machines yet, or
 * null when it is. Drives both the hard-deny at session start and the
 * IS_AVAILABLE gray-out.
 */
export function remoteBlockedProviderLabel(provider: ProviderKind): string | null {
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

function hasNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

type RemoteAuthAgent = Extract<AgentType, 'claude-code' | 'codex'>

export interface RemoteProviderAuthCheck {
  loggedIn: boolean
  loginCommand: string
  configDir: string
}

/** How long a `codex login status` verdict is trusted before re-probing.
 *  Long enough that opening several chats on a remote does not spawn a
 *  process per chat; short enough that a login the user just completed in
 *  another terminal shows up without restarting the backend. */
const CODEX_LOGIN_PROBE_TTL_MS = 15_000
const CODEX_LOGIN_PROBE_TIMEOUT_MS = 4_000
const codexLoginProbeCache = new Map<string, { at: number; loggedIn: boolean }>()
/** Probes still running, keyed by config dir. A burst of chat-opens against
 *  one remote shares a single child rather than forking one each. */
const codexLoginProbeInflight = new Map<string, Promise<boolean>>()

/** Test-only: drop memoized login verdicts between cases. */
export function __resetRemoteCodexLoginProbeCacheForTests(): void {
  codexLoginProbeCache.clear()
  codexLoginProbeInflight.clear()
}

/**
 * Ask Codex itself whether `configDir` is logged in.
 *
 * Codex keeps credentials in three places, and only one of them is a file we
 * can stat: `auth.json`, an `OPENAI_API_KEY`, or the OS keyring. A keyring
 * login leaves NOTHING under CODEX_HOME, so the file check alone told a
 * perfectly authenticated remote it had to run `codex login --device-auth`
 * again. `codex login status` is the only thing that knows about all three.
 *
 * ASYNC, and bounded on every other axis too. This runs on session start and
 * on the chat-open auth preflight; on a remote, the WsHost message pump lives
 * on the same event loop, so the `spawnSync` this replaced froze every chat,
 * PTY byte and streaming turn on the machine for the length of the probe. So:
 * argv (never a shell, hence no quoting needed and any dir is safe), a hard
 * timeout, a short result cache, and single-flight per dir so a burst of
 * chat-opens cannot become a burst of processes.
 *
 * Any failure - no codex on PATH, a timeout, an offline box - reads as NOT
 * logged in, which is the pre-existing behavior and keeps the actionable
 * login prompt in front of the user rather than failing the turn deeper down.
 */
function codexLoginStatusSaysLoggedIn(configDir: string): Promise<boolean> {
  const cached = codexLoginProbeCache.get(configDir)
  if (cached && Date.now() - cached.at < CODEX_LOGIN_PROBE_TTL_MS) return Promise.resolve(cached.loggedIn)
  const inflight = codexLoginProbeInflight.get(configDir)
  if (inflight) return inflight

  const run = new Promise<boolean>((resolve) => {
    execFile('codex', ['login', 'status'], {
      env: { ...process.env, CODEX_HOME: configDir, PATH: managedPath(process.env) },
      timeout: CODEX_LOGIN_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        log.warn(`codex login status probe failed: ${err.message}`)
        resolve(false)
        return
      }
      resolve(parsesAsLoggedIn(String(stdout ?? '')))
    })
  }).catch((err: unknown) => {
    // Spawn threw synchronously (no HOME, bad env) rather than calling back.
    log.warn(`codex login status probe failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }).then((loggedIn) => {
    codexLoginProbeCache.set(configDir, { at: Date.now(), loggedIn })
    codexLoginProbeInflight.delete(configDir)
    return loggedIn
  })

  codexLoginProbeInflight.set(configDir, run)
  return run
}

/** Accept both `--json`-style output and the human line Codex prints. An
 *  explicit "not logged in" always loses, whichever form it arrives in. */
function parsesAsLoggedIn(stdout: string): boolean {
  const text = stdout.trim()
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as { loggedIn?: unknown; logged_in?: unknown }
    if (parsed && typeof parsed === 'object') {
      return parsed.loggedIn === true || parsed.logged_in === true
    }
  } catch {
    /* not JSON - fall through to the prose form */
  }
  if (/\bnot logged in\b|\blogged out\b/i.test(text)) return false
  return /\blogged in\b|\bauthenticated\b/i.test(text)
}

/**
 * Async because the Codex branch may have to ask the CLI (see above). The
 * cheap signals are still checked first and short-circuit it: an API key in
 * the env or a non-empty `auth.json` answers the question with no child at
 * all, and the Claude branch never spawns anything.
 */
export async function checkRemoteProviderAuth(
  agentType: RemoteAuthAgent,
  configDir: string,
): Promise<RemoteProviderAuthCheck> {
  const codex = agentType === 'codex'
  const loggedIn = codex
    ? Boolean(process.env.OPENAI_API_KEY)
      || hasNonEmptyFile(join(configDir, 'auth.json'))
      || await codexLoginStatusSaysLoggedIn(configDir)
    : Boolean(process.env.ANTHROPIC_API_KEY) || hasNonEmptyFile(join(configDir, '.credentials.json'))
  // The dir reaches a shell the user pastes into, so it is quoted by the one
  // POSIX-safe quoter rather than a local regex that leaves `$` live.
  const loginCommand = codex
    ? `CODEX_HOME=${shellQuoteDir(configDir)} codex login --device-auth`
    : oauthInteractiveLoginCommand('claude-code', configDir) || 'claude'
  return { loggedIn, loginCommand, configDir }
}

export async function remoteProviderLoginPrompt(
  agentType: RemoteAuthAgent,
  configDir: string,
): Promise<string | null> {
  const check = await checkRemoteProviderAuth(agentType, configDir)
  if (check.loggedIn) return null
  if (agentType === 'codex') {
    return `This machine is not logged in to Codex. Open a terminal on it and run:\n\n    ${check.loginCommand}\n\nComplete the device sign-in in your local browser, then send your message again.`
  }
  return formatRemoteClaudeLoginPrompt(check.loginCommand)
}

/**
 * Structured result of the proactive remote-auth preflight. Unlike
 * `remoteClaudeLoginPrompt` (a prose backstop thrown at START_SESSION), this
 * feeds the renderer's chat-open banner, so it carries the raw pieces - the
 * verdict, the copyable login command, and the dir that was checked.
 */
export type RemoteClaudeAuthCheck = RemoteProviderAuthCheck

/**
 * Is a remote Claude session rooted at `configDir` able to authenticate?
 * Same signals as `remoteClaudeLoginPrompt` (non-empty `.credentials.json`,
 * or `ANTHROPIC_API_KEY` in the env), but returns structured data instead of
 * a prose prompt. Async only to share one shape with the Codex branch; the
 * Claude path spawns nothing.
 */
export function checkRemoteClaudeAuth(configDir: string): Promise<RemoteClaudeAuthCheck> {
  return checkRemoteProviderAuth('claude-code', configDir)
}

/**
 * Decide whether a remote Claude session can authenticate from `configDir`.
 * Returns null when it's logged in (a non-empty `.credentials.json` exists in
 * the dir, or `ANTHROPIC_API_KEY` is set); otherwise returns the actionable
 * per-device-login message to surface in chat.
 */
export function remoteClaudeLoginPrompt(configDir: string): Promise<string | null> {
  return remoteProviderLoginPrompt('claude-code', configDir)
}

/**
 * Pure: coerce a forwarded config-dir name into a single safe path segment.
 * The desktop sends the basename of a local oauth_dir (e.g. `.claude-akshaya`);
 * because it crosses the wire we treat it as untrusted and strip anything that
 * could escape `$HOME` (path separators, `..`, control chars). Anything except
 * `[A-Za-z0-9._-]` is removed; an empty result or a `.`/`..` segment falls back
 * to `.claude`.
 */
function sanitizeSegment(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return cleaned
}

export function sanitizeConfigSegment(name: string | undefined): string {
  return sanitizeSegment(name, '.claude')
}

let remoteDirsCache: { at: number; dirs: string[] } | null = null
const REMOTE_DIRS_TTL_MS = 10_000

/** Test-only: drop the memoized dir list between cases. */
export function __resetRemoteClaudeConfigDirCacheForTests(): void {
  remoteDirsCache = null
}

/**
 * List every Claude config dir on a remote VM. Sessions run under forwarded
 * per-instance config dirs the VM's provider_instances table doesn't know
 * about; forwarded dirs are always single segments under $HOME (see
 * sanitizeConfigSegment) but their NAME is free text from the desktop's
 * oauth_dir setting - `.claude*` is only a convention. So a dir qualifies by
 * either the naming convention or the `projects/` subdir the CLI creates.
 * Memoized briefly - this feeds hot paths (session scans, history loads).
 */
export function listRemoteClaudeConfigDirs(home: string = homedir()): string[] {
  const cacheable = home === homedir()
  if (cacheable && remoteDirsCache && Date.now() - remoteDirsCache.at < REMOTE_DIRS_TTL_MS) {
    return remoteDirsCache.dirs
  }
  let dirs: string[]
  try {
    dirs = readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(home, e.name))
      .filter((p) => {
        try {
          if (!statSync(p).isDirectory()) return false
          if (basename(p).startsWith('.claude')) return true
          return statSync(join(p, 'projects')).isDirectory()
        } catch {
          // Missing projects/ subdir or a dangling symlink - not a config dir.
          return false
        }
      })
  } catch (err) {
    log.warn('config-dir scan of home failed', err)
    dirs = []
  }
  if (cacheable) remoteDirsCache = { at: Date.now(), dirs }
  return dirs
}

/**
 * Resolve the absolute Claude config dir for a remote session from the
 * forwarded dir name, always under the VM's own `$HOME`. Falsy input (no
 * instance / env-mode instance) returns `~/.claude`. The name is sanitized to
 * a single segment first so a hostile payload can't traverse out of `$HOME`.
 */
export function remoteClaudeConfigDir(remoteConfigDir: string | undefined): string {
  return remoteProviderConfigDir('claude-code', remoteConfigDir)
}

export function remoteProviderConfigDir(
  agentType: RemoteAuthAgent,
  remoteConfigDir: string | undefined,
): string {
  const fallback = agentType === 'codex' ? '.codex' : '.claude'
  return join(homedir(), sanitizeSegment(remoteConfigDir, fallback))
}
