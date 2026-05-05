/**
 * IPC handlers for provider-instance CRUD.
 *
 * Renderer calls these via `window.api.providerInstances.*`. Sensitive
 * env values are accepted in plaintext over the contextBridge, encrypted
 * by `db/providerInstances.ts` before persisting, and never sent back
 * (the wire shape only includes `envKeys`, not values).
 */

import { ipcMain } from 'electron'
import { spawnSync } from 'child_process'
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
  type ProviderInstanceUpsertInput,
} from '../db/providerInstances'
import { findClaudeBin, buildClaudeCliEnv } from '../provider/adapters/claude-adapter'
import { findCodexPath, buildCodexCliEnv } from '../provider/adapters/codex-adapter'
import { findOpencodePath, buildOpencodeEnv } from '../provider/adapters/opencode/env'
import { applyEnvOverlay } from '../provider/env-overlay'

const log = createLogger('ipc:provider-instances')

export function registerProviderInstanceHandlers(): void {
  ipcMain.handle(ProviderInstanceChannels.LIST, () => {
    try {
      return listProviderInstances()
    } catch (err) {
      log.warn(`list failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  })

  ipcMain.handle(ProviderInstanceChannels.UPSERT, (_event, input: ProviderInstanceUpsertInput) => {
    log.info(`upsert ${input.id ?? '(new)'} agent=${input.agentType} name="${input.displayName}"`)
    return upsertProviderInstance(input)
  })

  ipcMain.handle(ProviderInstanceChannels.DELETE, (_event, id: string) => {
    log.info(`delete ${id}`)
    return deleteProviderInstance(id)
  })

  ipcMain.handle(ProviderInstanceChannels.TEST, async (_event, id: string) => {
    return testInstance(id)
  })

  ipcMain.handle(ProviderInstanceChannels.CREATE_OAUTH_DIR, (_event, dir: string) => {
    return createOauthDir(dir)
  })

  log.info('IPC handlers registered')
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return `${homedir()}${path.slice(1)}`
  return path
}

function createOauthDir(dir: string): { ok: boolean; path?: string; error?: string } {
  const trimmed = dir.trim()
  if (!trimmed) return { ok: false, error: 'OAuth directory path is required.' }
  const expanded = expandHomePath(trimmed)
  try {
    mkdirSync(expanded, { recursive: true })
    return { ok: true, path: expanded }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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

  const env: Record<string, string> = instance.agentType === 'codex'
    ? buildCodexCliEnv()
    : instance.agentType === 'claude-code'
      ? buildClaudeCliEnv()
      : { ...(process.env as Record<string, string>) }
  applyEnvOverlay(env, instance.env)
  if (instance.oauthDir && instance.oauthDir.length > 0) {
    if (instance.agentType === 'claude-code') env.CLAUDE_CONFIG_DIR = instance.oauthDir
    if (instance.agentType === 'codex') env.CODEX_HOME = instance.oauthDir
  }

  try {
    if (instance.agentType === 'claude-code') {
      const bin = findClaudeBin()
      if (!bin) return { ok: false, message: 'claude binary not found — install Claude Code and ensure it is on PATH' }
      const out = spawnSync(bin, ['auth', 'status'], { env, timeout: 7000, encoding: 'utf-8' })
      if (out.error) return { ok: false, message: `claude error: ${out.error.message}` }
      if (out.status !== 0) {
        const stderr = out.stderr?.trim() || out.stdout?.trim() || `exit ${out.status}`
        const command = oauthLoginCommand('claude-code', instance.oauthDir || '~/.claude')
        return {
          ok: false,
          message: `${stderr}. Run: ${command}`,
        }
      }
      return formatClaudeAuthStatus(out.stdout, instance.oauthDir)
    }
    if (instance.agentType === 'codex') {
      const codexBin = findCodexPath()
      if (!codexBin) return { ok: false, message: 'codex binary not found — install Codex and ensure it is on PATH' }
      const out = spawnSync(codexBin, ['login', 'status'], { env, timeout: 5000, encoding: 'utf-8' })
      if (out.error) return { ok: false, message: `codex error: ${out.error.message}` }
      // `codex login status` exits 0 when logged in; non-zero means not logged in.
      if (out.status !== 0) {
        const stderr = out.stderr?.trim() || out.stdout?.trim() || `exit ${out.status}`
        const command = oauthLoginCommand('codex', instance.oauthDir || '~/.codex')
        return { ok: false, message: `Not logged in for CODEX_HOME=${env.CODEX_HOME ?? '<default>'}: ${stderr}. Run: ${command}` }
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
      const out = spawnSync(bin, ['models'], { env: probeEnv, timeout: 8000, encoding: 'utf-8' })
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
