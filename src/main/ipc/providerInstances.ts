/**
 * IPC handlers for provider-instance CRUD.
 *
 * Renderer calls these via `window.api.providerInstances.*`. Sensitive
 * env values are accepted in plaintext over the contextBridge, encrypted
 * by `db/providerInstances.ts` before persisting, and never sent back
 * (the wire shape only includes `envKeys`, not values).
 */

import type { BackendHost } from '../backend/host'
import { execFile } from 'child_process'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { ProviderInstanceChannels } from '@shared/ipc-channels'
import { formatClaudeAuthStatus, oauthLoginCommand } from '@shared/provider-auth-format'
import { createMainLogger as createLogger } from '../logger'
import {
  listProviderInstances,
  upsertProviderInstance,
  deleteProviderInstance,
  getProviderInstanceFull,
  resolveEffectiveOauthDir,
  type ProviderInstanceUpsertInput,
  type ProviderInstanceWire,
} from '../db/providerInstances'
import { findClaudeBin } from '../provider/adapters/claude-adapter'
import { findCodexPath } from '../provider/adapters/codex-adapter'
import { findOpencodePath, buildOpencodeEnv } from '../provider/adapters/opencode/env'
import { applyEnvOverlay } from '../provider/env-overlay'
import { resolveInstanceEnv } from '../provider/instance-env'
import { resolveOauthDirForCreate } from '../provider/oauth-path'
import { fetchInstanceUsage, invalidateUsage } from '../provider/usage'

const log = createLogger('ipc:provider-instances')

export function registerProviderInstanceHandlers(host: BackendHost): void {
  host.handle(ProviderInstanceChannels.LIST, () => {
    try {
      return withResolvedEffectiveHomes(listProviderInstances())
    } catch (err) {
      log.warn(`list failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  })

  host.handle(ProviderInstanceChannels.UPSERT, (input: ProviderInstanceUpsertInput) => {
    log.info(`upsert ${input.id ?? '(new)'} agent=${input.agentType} name="${input.displayName}"`)
    const saved = upsertProviderInstance(input)
    // An edited oauth dir or env overlay points at a different credential.
    invalidateUsage(saved.id)
    return withResolvedEffectiveHomes([saved])[0]
  })

  host.handle(ProviderInstanceChannels.DELETE, (id: string) => {
    log.info(`delete ${id}`)
    invalidateUsage(id)
    return deleteProviderInstance(id)
  })

  host.handle(ProviderInstanceChannels.TEST, async (id: string) => {
    return testInstance(id)
  })

  host.handle(ProviderInstanceChannels.USAGE, async (id: string, opts?: { force?: boolean }) => {
    return fetchInstanceUsage(id, opts)
  })

  host.handle(ProviderInstanceChannels.CREATE_OAUTH_DIR, (dir: string) => {
    return createOauthDir(dir)
  })

  log.info('IPC handlers registered')
}

/**
 * Memoized `id:updatedAt` -> resolved home. The DB layer leaves a row
 * `unresolved` when only its encrypted overlay knows the answer; resolving it
 * decrypts, which on macOS means the keychain. LIST runs often (every Settings
 * open, every instance save), so the answer is cached per ROW VERSION - a save
 * bumps `updatedAt` and invalidates it on its own.
 */
const resolvedHomeMemo = new Map<string, {
  effectiveOauthDir: string | null
  effectiveOauthDirSource: ProviderInstanceWire['effectiveOauthDirSource']
}>()

/**
 * Replace every `unresolved` effective home with the real one.
 *
 * Main is the authoritative layer for this: it is the only place that may
 * decrypt an instance's env overlay, and the overlay is where a legacy
 * env-mode profile keeps its CODEX_HOME / CLAUDE_CONFIG_DIR. Without this the
 * renderer would show such a profile sitting on the canonical default while
 * every session it starts runs somewhere else.
 *
 * A row that still cannot be read (no keychain, wrong host) stays
 * `unresolved` with a null directory - visibly unknown, never a guess.
 */
export function withResolvedEffectiveHomes(rows: ProviderInstanceWire[]): ProviderInstanceWire[] {
  return rows.map((row) => {
    if (row.effectiveOauthDirSource !== 'unresolved') return row
    const key = `${row.id}:${row.updatedAt}`
    const memo = resolvedHomeMemo.get(key)
    if (memo) return { ...row, ...memo }
    try {
      const resolved = resolveEffectiveOauthDir(row.id)
      if (!resolved) return row
      resolvedHomeMemo.set(key, resolved)
      return { ...row, ...resolved }
    } catch (err) {
      log.warn(`could not resolve effective home for ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      return row
    }
  })
}

/**
 * Create a credential directory for the Settings → Providers "Create" button.
 *
 * Exported so the contract is testable without the renderer: the path arrives
 * as free text over IPC, so the confinement decision (see
 * `resolveOauthDirForCreate`) has to live behind the handler, not in front of
 * it in the UI. Two things it deliberately does NOT do:
 *
 *   - It never chmods a directory that already exists. `mkdir` applies `mode`
 *     only to the directories it creates, so pointing the button at an
 *     existing dir is a no-op rather than a silent permission change to
 *     something the user has other plans for.
 *   - It never echoes anything but the path back. The error text goes to the
 *     renderer, and env values / tokens have no business in it.
 *
 * 0700 because the directory is about to hold OAuth tokens: default umask
 * would leave them group/world-readable on a shared machine.
 */
export function createOauthDir(dir: string): { ok: boolean; path?: string; error?: string } {
  const resolved = resolveOauthDirForCreate(dir ?? '', homedir())
  if (!resolved.ok) return { ok: false, error: resolved.error }
  try {
    mkdirSync(resolved.path, { recursive: true, mode: 0o700 })
    return { ok: true, path: resolved.path }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`create oauth dir failed: ${message}`)
    return { ok: false, error: `Could not create ${resolved.path}: ${message}` }
  }
}

interface ProbeResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

/**
 * Async replacement for the old `spawnSync` probes, mirroring spawnSync's
 * result shape so the branch logic below is unchanged. spawnSync froze the
 * whole main-process event loop for up to the probe timeout (5-8s) - every
 * PTY and streaming turn stalled while a Settings "Test" ran.
 */
function runProbe(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ status: 0, stdout, stderr })
        return
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      // Timeout: execFile kills the child and sets .killed.
      if (e.killed) {
        resolve({ status: null, stdout, stderr, error: new Error(`timed out after ${timeoutMs}ms`) })
        return
      }
      // Non-zero exit: numeric .code. Spawn failure (ENOENT etc.): string .code.
      if (typeof e.code === 'number') {
        resolve({ status: e.code, stdout, stderr })
        return
      }
      resolve({ status: null, stdout, stderr, error: e })
    })
  })
}

/**
 * Probe an instance's credentials with a no-op call. Each agent kind
 * has its own cheap "is this binary installed and authenticated" check:
 *   - claude: `claude auth status` (verifies login under CLAUDE_CONFIG_DIR)
 *   - codex: `codex login status` (resolves CODEX_HOME)
 *   - opencode: `opencode models` (lists models, validates API keys)
 * Returns `{ ok, message }` so the UI can render a green/red status row.
 */
async function testInstance(id: string): Promise<{ ok: boolean; message: string }> {
  const instance = getProviderInstanceFull(id)
  if (!instance) return { ok: false, message: 'Instance not found.' }

  const env = resolveInstanceEnv(instance)

  try {
    if (instance.agentType === 'claude-code') {
      const bin = findClaudeBin()
      if (!bin) return { ok: false, message: 'claude binary not found - install Claude Code and ensure it is on PATH' }
      const out = await runProbe(bin, ['auth', 'status'], env, 7000)
      if (out.error) return { ok: false, message: `claude error: ${out.error.message}` }
      // The home the probe REALLY ran under, not the oauth_dir column: a
      // legacy env-mode profile keeps its home in the overlay, and telling
      // that user to log in to `~/.claude` would leave the profile that just
      // failed exactly as logged-out as before.
      const configDir = env.CLAUDE_CONFIG_DIR || '~/.claude'
      if (out.status !== 0) {
        const stderr = out.stderr?.trim() || out.stdout?.trim() || `exit ${out.status}`
        return {
          ok: false,
          message: `${stderr}. Run: ${oauthLoginCommand('claude-code', configDir)}`,
        }
      }
      return formatClaudeAuthStatus(out.stdout, configDir)
    }
    if (instance.agentType === 'codex') {
      const codexBin = findCodexPath()
      if (!codexBin) return { ok: false, message: 'codex binary not found - install Codex and ensure it is on PATH' }
      const out = await runProbe(codexBin, ['login', 'status'], env, 5000)
      if (out.error) return { ok: false, message: `codex error: ${out.error.message}` }
      // `codex login status` exits 0 when logged in; non-zero means not logged in.
      if (out.status !== 0) {
        const stderr = out.stderr?.trim() || out.stdout?.trim() || `exit ${out.status}`
        // Same rule as Claude above: name the home that was tested.
        const configDir = env.CODEX_HOME || '~/.codex'
        const command = oauthLoginCommand('codex', configDir)
        return { ok: false, message: `Not logged in for CODEX_HOME=${configDir}: ${stderr}. Run: ${command}` }
      }
      return { ok: true, message: out.stdout.trim() || 'Logged in to Codex.' }
    }
    if (instance.agentType === 'opencode') {
      const bin = findOpencodePath()
      if (!bin) return { ok: false, message: 'opencode binary not found on PATH' }
      // Layer the instance overlay onto buildOpencodeEnv so shell + settings keys still apply.
      const overlay: Record<string, string> = {}
      applyEnvOverlay(overlay, instance.env)
      const probeEnv = buildOpencodeEnv(overlay)
      const out = await runProbe(bin, ['models'], probeEnv, 8000)
      if (out.error) return { ok: false, message: out.error.message }
      if (out.status !== 0) return { ok: false, message: out.stderr?.trim() || `exit ${out.status}` }
      const lines = (out.stdout ?? '').split('\n').filter((l) => l.trim().length > 0)
      return { ok: true, message: `${lines.length} models available` }
    }
    return { ok: false, message: `unknown agent kind: ${instance.agentType}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
