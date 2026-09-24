/**
 * The live model catalog of a provider instance, without a chat. A running
 * session already answers `listModels`; this is for everything before one
 * exists (a new chat, a fresh instance, the phone's New Session screen), so
 * models a provider launches after our release show up everywhere.
 *
 * Each probe starts the provider's own process with the instance's
 * credentials, asks for its model list and exits. No turn is sent, so no
 * usage is spent. Results are cached per instance for an hour; a live
 * session's own list stays authoritative inside that chat.
 */
import { execFile } from 'child_process'
import { homedir } from 'os'
import { formatOpencodeModelLabel, inferModelTier, type ModelOption } from '@shared/models'
import type { AgentProvider } from '@shared/types'
import { resolveProviderInstance } from '../db/provider-instances'
import { createMainLogger } from '../logger'
import { buildClaudeCliEnv, findClaudeBin } from './adapters/claude-adapter'
import { buildCodexCliEnv, findCodexPath, parseCodexModels } from './adapters/codex-adapter'
import { buildOpencodeEnv, findOpencodePath } from './adapters/opencode/env'
import { applyCredentialHome } from './credential-home'
import { applyEnvOverlay } from './env-overlay'
import { resolveInstanceEnv } from './instance-env'
import { remoteProviderConfigDir } from './remote-gate'
import { CodexProbeSession } from './usage/codex-usage'

const log = createMainLogger('provider:catalog-probe')

const TTL_MS = 60 * 60_000
const PROBE_TIMEOUT_MS = 20_000

const cache = new Map<string, { models: ModelOption[]; at: number }>()
const inFlight = new Map<string, Promise<ModelOption[]>>()

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), PROBE_TIMEOUT_MS)),
  ])
}

async function probeClaude(env: Record<string, string>): Promise<ModelOption[]> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const claudeBin = findClaudeBin()
  // A prompt that never yields: the CLI starts and answers control requests,
  // but no user turn is ever sent.
  const prompt = (async function* () { await new Promise<never>(() => {}) })()
  const query = sdk.query({
    prompt,
    options: { cwd: homedir(), env, ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}) },
  })
  try {
    const models = await withTimeout(query.supportedModels(), 'claude supportedModels')
    return models.map((m) => ({
      id: m.value,
      label: m.displayName,
      tier: inferModelTier(m.value),
      ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    }))
  } finally {
    query.close()
  }
}

async function probeCodex(env: Record<string, string>): Promise<ModelOption[]> {
  const bin = findCodexPath()
  if (!bin) throw new Error('codex binary not found')
  const probe = new CodexProbeSession(bin, env)
  try {
    await probe.send('initialize', { clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.1.0' } }, PROBE_TIMEOUT_MS)
    probe.notify('initialized')
    return parseCodexModels(await probe.send('model/list', { limit: 100, includeHidden: false }, PROBE_TIMEOUT_MS))
  } finally {
    probe.dispose()
  }
}

function probeOpencode(instanceEnv: Record<string, string>): Promise<ModelOption[]> {
  const bin = findOpencodePath()
  if (!bin) return Promise.reject(new Error('opencode binary not found'))
  const overlay: Record<string, string> = {}
  applyEnvOverlay(overlay, instanceEnv)
  return new Promise((resolve, reject) => {
    execFile(bin, ['models'], { env: buildOpencodeEnv(overlay), timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      const ids = stdout.split('\n').map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line))
      resolve(ids.map((id) => ({ id, label: formatOpencodeModelLabel(id), tier: inferModelTier(id) })))
    })
  })
}

interface ProbeTarget {
  key: string
  env: Record<string, string>
  instanceEnv: Record<string, string>
}

/**
 * Which credentials to probe with. A remote backend has no desktop profile
 * rows, so the desktop forwards the profile's config-dir basename, exactly as
 * startSession does, and the probe uses that dir's credential home.
 */
function probeTarget(agentType: AgentProvider, instanceId: string | null | undefined, remoteConfigDir?: string): ProbeTarget {
  if (remoteConfigDir && agentType !== 'opencode') {
    const dir = remoteProviderConfigDir(agentType, remoteConfigDir)
    const env = agentType === 'claude-code' ? buildClaudeCliEnv() : buildCodexCliEnv()
    applyCredentialHome(env, agentType, dir)
    return { key: `${agentType}:dir:${dir}`, env, instanceEnv: {} }
  }
  let instance: ReturnType<typeof resolveProviderInstance> = null
  try {
    instance = resolveProviderInstance(agentType, instanceId ?? null)
  } catch (err) {
    log.warn(`catalog probe: instance ${instanceId} unknown here, probing the default`, err)
    instance = resolveProviderInstance(agentType, null)
  }
  const env = instance
    ? resolveInstanceEnv(instance)
    : agentType === 'codex' ? buildCodexCliEnv() : agentType === 'claude-code' ? buildClaudeCliEnv() : { ...(process.env as Record<string, string>) }
  return { key: `${agentType}:${instance?.id ?? 'default'}`, env, instanceEnv: instance?.env ?? {} }
}

/** A cached catalog if one is fresh; never spawns. Seeds a session's first turn. */
export function peekCatalog(agentType: AgentProvider, instanceId?: string | null, remoteConfigDir?: string): ModelOption[] | undefined {
  try {
    const hit = cache.get(probeTarget(agentType, instanceId, remoteConfigDir).key)
    return hit && Date.now() - hit.at < TTL_MS ? hit.models : undefined
  } catch (err) {
    log.warn('catalog peek failed', err)
    return undefined
  }
}

/** Live catalog for an instance, or [] when it cannot be probed (no binary, signed out). */
export function probeCatalog(agentType: AgentProvider, instanceId?: string | null, remoteConfigDir?: string): Promise<ModelOption[]> {
  const target = probeTarget(agentType, instanceId, remoteConfigDir)
  const key = target.key
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.models)
  const running = inFlight.get(key)
  if (running) return running

  const task = (async () => {
    try {
      const models = agentType === 'claude-code'
        ? await probeClaude(target.env)
        : agentType === 'codex'
          ? await probeCodex(target.env)
          : await probeOpencode(target.instanceEnv)
      // An empty answer is not cached, so the next ask retries.
      if (models.length > 0) cache.set(key, { models, at: Date.now() })
      return models
    } catch (err) {
      log.warn(`catalog probe failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, task)
  return task
}

/** Forget a cached catalog, e.g. after an instance's credentials change. */
export function invalidateCatalog(): void {
  cache.clear()
}
