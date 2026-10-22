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
 *
 * The cache is also kept on disk, so a launch answers at once instead of
 * starting every provider's CLI (over a second each). An entry older than the
 * hour is still answered, and a probe refreshes it behind the reply.
 */
import { isGenericAcpAgent } from '@shared/acp-agents'
import { execFile } from 'child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { formatOpencodeModelLabel, inferModelTier, type ModelOption } from '@shared/models'
import type { AgentProvider } from '@shared/types'
import { resolveProviderInstance } from '../db/provider-instances'
import { createMainLogger } from '../logger'
import { buildClaudeCliEnv, findClaudeBin } from './adapters/claude-adapter'
import { claudeModelOptions } from './claude-models'
import { buildCodexCliEnv, findCodexPath, parseCodexModels } from './adapters/codex-adapter'
import { buildOpencodeEnv, findOpencodePath } from './adapters/opencode/env'
import { assertSupportedOpencode } from './adapters/opencode/version'
import { opencodeModelsArgs } from './adapters/opencode/cli-args'
import { applyCredentialHome } from './credential-home'
import { applyEnvOverlay } from './env-overlay'
import { resolveInstanceEnv } from './instance-env'
import { remoteProviderConfigDir } from './remote-gate'
import { userDataDir } from '../runtime'
import { CodexProbeSession } from './usage/codex-usage'

const log = createMainLogger('provider:catalog-probe')

const TTL_MS = 60 * 60_000
const PROBE_TIMEOUT_MS = 20_000

type CacheEntry = { models: ModelOption[]; at: number }
let cache: Map<string, CacheEntry> | null = null
const inFlight = new Map<string, Promise<ModelOption[]>>()
// Bumped by invalidateCatalog, so a probe started before it stores nothing.
let generation = 0

function cacheFile(): string {
  return join(userDataDir(), 'data', 'model-catalog.json')
}

function loadedCache(): Map<string, CacheEntry> {
  if (cache) return cache
  cache = new Map()
  try {
    const stored = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Record<string, CacheEntry>
    for (const [key, entry] of Object.entries(stored)) {
      const valid =
        Array.isArray(entry?.models) &&
        entry.models.every((m) => typeof m?.id === 'string' && typeof m.label === 'string') &&
        typeof entry.at === 'number' &&
        entry.at <= Date.now()
      if (valid) cache.set(key, entry)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('catalog cache unreadable, starting empty', err)
  }
  return cache
}

function saveCache(): void {
  const file = cacheFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(loadedCache())))
    renameSync(`${file}.tmp`, file)
  } catch (err) {
    log.warn('catalog cache not saved', err)
  }
}

function storeProbe(key: string, models: ModelOption[]): void {
  const entries = loadedCache()
  if (models.length > 0) entries.set(key, { models, at: Date.now() })
  else if (!entries.delete(key)) return
  saveCache()
}

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
  const prompt = (async function* () {
    await new Promise<never>(() => {})
  })()
  const query = sdk.query({
    prompt,
    options: { cwd: homedir(), env, ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}) },
  })
  try {
    const models = await withTimeout(query.supportedModels(), 'claude supportedModels')
    return claudeModelOptions(models)
  } finally {
    query.close()
  }
}

async function probeCodex(env: Record<string, string>): Promise<ModelOption[]> {
  const bin = findCodexPath()
  if (!bin) throw new Error('codex binary not found')
  const probe = new CodexProbeSession(bin, env)
  try {
    await probe.send(
      'initialize',
      { clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.1.0' } },
      PROBE_TIMEOUT_MS,
    )
    probe.notify('initialized')
    return parseCodexModels(await probe.send('model/list', { limit: 100, includeHidden: false }, PROBE_TIMEOUT_MS))
  } finally {
    probe.dispose()
  }
}

async function probeOpencode(instanceEnv: Record<string, string>): Promise<ModelOption[]> {
  const bin = findOpencodePath()
  if (!bin) throw new Error('opencode binary not found')
  const overlay: Record<string, string> = {}
  applyEnvOverlay(overlay, instanceEnv)
  const env = buildOpencodeEnv(overlay)
  const generation = await assertSupportedOpencode(bin, env)
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      opencodeModelsArgs(generation),
      { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        const ids = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[\w.-]+\/\S+$/.test(line))
        resolve(ids.map((id) => ({ id, label: formatOpencodeModelLabel(id), tier: inferModelTier(id) })))
      },
    )
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
function probeTarget(
  agentType: AgentProvider,
  instanceId: string | null | undefined,
  remoteConfigDir?: string,
): ProbeTarget {
  if (remoteConfigDir && (agentType === 'claude-code' || agentType === 'codex')) {
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
    : agentType === 'codex'
      ? buildCodexCliEnv()
      : agentType === 'claude-code'
        ? buildClaudeCliEnv()
        : { ...(process.env as Record<string, string>) }
  return { key: `${agentType}:${instance?.id ?? 'default'}`, env, instanceEnv: instance?.env ?? {} }
}

/** A cached catalog if one is fresh; never spawns. Seeds a session's first turn. */
export function peekCatalog(
  agentType: AgentProvider,
  instanceId?: string | null,
  remoteConfigDir?: string,
): ModelOption[] | undefined {
  try {
    const hit = loadedCache().get(probeTarget(agentType, instanceId, remoteConfigDir).key)
    return hit && Date.now() - hit.at < TTL_MS ? hit.models : undefined
  } catch (err) {
    log.warn('catalog peek failed', err)
    return undefined
  }
}

/**
 * Live catalog for an instance, or [] when it cannot be probed (no binary,
 * signed out). A stale cached catalog is answered at once while a probe
 * refreshes it.
 */
export function probeCatalog(
  agentType: AgentProvider,
  instanceId?: string | null,
  remoteConfigDir?: string,
): Promise<ModelOption[]> {
  const target = probeTarget(agentType, instanceId, remoteConfigDir)
  const key = target.key
  const hit = loadedCache().get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.models)
  const running = inFlight.get(key)
  if (running) return hit ? Promise.resolve(hit.models) : running

  const started = generation
  const task = (async () => {
    try {
      // A generic ACP agent lists its models only inside a session, so
      // there is nothing to probe ahead of one.
      const models =
        agentType === 'claude-code'
          ? await probeClaude(target.env)
          : agentType === 'codex'
            ? await probeCodex(target.env)
            : isGenericAcpAgent(agentType)
              ? []
              : await probeOpencode(target.instanceEnv)
      // An empty answer is not cached, so the next ask retries, and it drops
      // a stale entry (signed out, CLI removed).
      if (started === generation) storeProbe(key, models)
      return models
    } catch (err) {
      log.warn(`catalog probe failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
      if (started === generation) storeProbe(key, [])
      return []
    } finally {
      if (started === generation) inFlight.delete(key)
    }
  })()
  inFlight.set(key, task)
  return hit ? Promise.resolve(hit.models) : task
}

/** Forget every cached catalog, e.g. after an instance's credentials change. */
export function invalidateCatalog(): void {
  generation++
  cache = new Map()
  inFlight.clear()
  try {
    rmSync(cacheFile(), { force: true })
  } catch (err) {
    log.warn('catalog cache not removed', err)
  }
}
