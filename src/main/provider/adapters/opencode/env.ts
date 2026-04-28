/**
 * Shared helpers for the OpenCode adapters (legacy shell-out + ACP).
 *
 * These were originally lived inline in `opencode-adapter.ts`. The ACP
 * rewrite still needs binary discovery, login-shell env probing, and
 * settings-DB key injection — but neither adapter should own the helpers
 * exclusively while both are in-tree behind the feature flag.
 */

import { spawnSync, execSync } from 'child_process'
import { basename, join as joinPath } from 'path'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { createMainLogger as createLogger } from '../../../logger'
import { getSetting } from '../../../db/database'

const log = createLogger('provider:opencode:env')

/**
 * API keys persisted in the settings table and injected at spawn time.
 * Matches `{env:VAR}` keys users put in their opencode.json. Settings DB
 * wins over shell env so users can override without editing shell profiles.
 */
export const OPENCODE_API_KEYS = [
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
] as const

let cachedPath: string | null | undefined

/** Find opencode binary on PATH and common install locations. */
export function findOpencodePath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    `${home}/.local/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    `${home}/node_modules/.bin/opencode`,
  ]
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { timeout: 2000 })
      cachedPath = p
      return p
    } catch { /* not found */ }
  }
  try {
    cachedPath = execSync('which opencode 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000,
    }).trim().split('\n')[0] || null
  } catch {
    cachedPath = null
  }
  return cachedPath
}

let cachedShellEnv: Record<string, string> | null | undefined

/**
 * Load env vars from the user's login shell. Electron on macOS doesn't
 * source ~/.zshrc when launched from Finder, so NVIDIA_API_KEY etc. would
 * otherwise be missing from process.env. Pattern from OpenCode's own
 * desktop app (packages/desktop-electron/src/main/shell-env.ts).
 */
export function loadShellEnv(): Record<string, string> | null {
  if (cachedShellEnv !== undefined) return cachedShellEnv
  if (process.platform === 'win32') {
    log.info('shell env probe skipped on Windows')
    cachedShellEnv = null
    return null
  }
  const shell = process.env.SHELL || '/bin/sh'
  const name = basename(shell).toLowerCase()
  if (name === 'nu' || name === 'nu.exe') {
    cachedShellEnv = null
    return null
  }
  const tryProbe = (flag: '-il' | '-l'): Record<string, string> | null => {
    const out = spawnSync(shell, [flag, '-c', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    })
    if (out.error || out.status !== 0) return null
    const env: Record<string, string> = {}
    for (const line of out.stdout.toString('utf8').split('\0')) {
      if (!line) continue
      const ix = line.indexOf('=')
      if (ix <= 0) continue
      env[line.slice(0, ix)] = line.slice(ix + 1)
    }
    return Object.keys(env).length > 0 ? env : null
  }
  const env = tryProbe('-il') ?? tryProbe('-l')
  cachedShellEnv = env
  if (env) {
    const hasNvidia = 'NVIDIA_API_KEY' in env
    log.info(`shell env loaded: ${Object.keys(env).length} vars (NVIDIA_API_KEY ${hasNvidia ? 'present' : 'MISSING'})`)
  } else {
    log.warn('shell env probe failed — opencode may not see API keys from ~/.zshrc')
  }
  return env
}

/**
 * Build the merged env Record for spawning opencode children.
 * Layering (later wins):
 *   shell-env  <  process.env  <  settings-DB keys
 */
export function buildOpencodeEnv(extra?: Record<string, string>): Record<string, string> {
  const shellEnv = loadShellEnv()
  const merged: Record<string, string> = shellEnv
    ? { ...shellEnv, ...(process.env as Record<string, string>) }
    : { ...(process.env as Record<string, string>) }
  const injected: string[] = []
  for (const key of OPENCODE_API_KEYS) {
    try {
      const val = getSetting(`opencode.env.${key}`)
      if (val && val.length > 0) {
        merged[key] = val
        injected.push(key)
      }
    } catch { /* settings table optional */ }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) merged[k] = v
  }
  if (injected.length > 0) {
    log.info(`injecting ${injected.length} API key(s) from settings: ${injected.join(', ')}`)
  }
  return merged
}

let cachedUserProviders: Set<string> | undefined

/**
 * Read the user's opencode config to extract user-configured provider keys
 * (e.g. ["nvidia-nim", "google"]). Used to dedupe model lists where the
 * same model appears under multiple provider IDs. Cached for the lifetime
 * of the process.
 */
export function getUserConfiguredProviders(): Set<string> {
  if (cachedUserProviders) return cachedUserProviders
  const result = new Set<string>()
  const candidates = [
    process.env.XDG_CONFIG_HOME
      ? joinPath(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')
      : null,
    joinPath(homedir(), '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean) as string[]

  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'))
      const providers = parsed?.provider
      if (providers && typeof providers === 'object') {
        for (const key of Object.keys(providers)) result.add(key)
        log.info(`user-configured opencode providers: ${Array.from(result).join(', ') || '(none)'}`)
        break
      }
    } catch (err: any) {
      log.warn(`failed to read opencode config at ${p}: ${err?.message}`)
    }
  }
  cachedUserProviders = result
  return result
}

/**
 * Dedupe model IDs that appear under multiple provider prefixes, preferring
 * user-configured providers (those have working API keys). Stable order:
 * preserves the input ordering.
 */
export function dedupeModelIds(ids: string[]): string[] {
  const userProviders = getUserConfiguredProviders()
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const slash = id.indexOf('/')
    if (slash === -1) continue
    const suffix = id.slice(slash + 1)
    const arr = groups.get(suffix) ?? []
    arr.push(id)
    groups.set(suffix, arr)
  }
  const picked: string[] = []
  for (const [, candidates] of groups) {
    if (candidates.length === 1) {
      picked.push(candidates[0])
      continue
    }
    const user = candidates.filter((c) => userProviders.has(c.split('/')[0]))
    if (user.length > 0) {
      picked.push(user.sort((a, b) => b.length - a.length)[0])
    } else {
      picked.push(candidates.sort()[0])
    }
  }
  const order = new Map(ids.map((id, i) => [id, i]))
  picked.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return picked
}

/**
 * Test-only: reset all caches. Lets unit tests probe behavior under
 * different `process.env`, settings DB, or filesystem states without
 * spawning a fresh process.
 */
export function _resetOpencodeEnvCachesForTests(): void {
  cachedPath = undefined
  cachedShellEnv = undefined
  cachedUserProviders = undefined
}
