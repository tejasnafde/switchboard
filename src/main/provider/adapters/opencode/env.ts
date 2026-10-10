/**
 * Shared helpers for the OpenCode adapters (legacy shell-out + ACP).
 *
 * These were originally lived inline in `opencode-adapter.ts`. The ACP
 * rewrite still needs binary discovery, login-shell env probing, and
 * settings-DB key injection - but neither adapter should own the helpers
 * exclusively while both are in-tree behind the feature flag.
 */

import { execSync } from 'child_process'
import { createMainLogger as createLogger } from '../../../logger'
import { getSetting } from '../../../db/database'
import { _resetShellEnvCacheForTests, peekShellEnv } from '../../../shell-env'

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

/** Install locations probed before falling back to `which`, in order. */
export function opencodeCandidatePaths(home: string): string[] {
  return [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    `${home}/.local/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    `${home}/node_modules/.bin/opencode`,
    // Where the curl installers (v1 and v2) put it. Last, so an npm or brew
    // 1.x install wins over a curl-installed 2.x on the same machine.
    `${home}/.opencode/bin/opencode`,
  ]
}

/** Find opencode binary on PATH and common install locations. */
export function findOpencodePath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const candidates = opencodeCandidatePaths(process.env.HOME || '')
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { timeout: 2000 })
      cachedPath = p
      return p
    } catch (err) {
      log.debug(`opencode not found at candidate path ${p}`, err)
    }
  }
  try {
    cachedPath =
      execSync('which opencode 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      })
        .trim()
        .split('\n')[0] || null
  } catch (err) {
    log.debug('opencode not found on PATH', err)
    cachedPath = null
  }
  return cachedPath
}

/**
 * Build the merged env Record for spawning opencode children.
 * Layering (later wins):
 *   shell-env  <  process.env  <  settings-DB keys
 */
export function buildOpencodeEnv(extra?: Record<string, string>): Record<string, string> {
  // Non-blocking: this builds the env for the Settings "Test" probe and for
  // opencode spawns, both on the main event loop. Cold, the shell PATH is
  // simply absent for that first call (process.env still applies) and the
  // warmup it schedules serves every later one.
  const shellEnv = peekShellEnv()
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
    } catch (err) {
      log.debug(`settings lookup for opencode.env.${key} failed - settings table optional`, err)
    }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) merged[k] = v
  }
  if (injected.length > 0) {
    log.info(`injecting ${injected.length} API key(s) from settings: ${injected.join(', ')}`)
  }
  return merged
}

/**
 * Test-only: reset all caches. Lets unit tests probe behavior under
 * different `process.env`, settings DB, or filesystem states without
 * spawning a fresh process.
 */
export function _resetOpencodeEnvCachesForTests(): void {
  cachedPath = undefined
  _resetShellEnvCacheForTests()
}
