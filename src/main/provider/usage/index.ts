/**
 * Per-instance subscription usage lookup, behind the Settings "Usage" button.
 *
 * Read-only: nothing here writes a credential, refreshes a token, or touches
 * a running session.
 */

import { getProviderInstanceFull } from '../../db/providerInstances'
import { resolveInstanceEnv } from '../instance-env'
import { findCodexPath } from '../adapters/codex-adapter'
import type { ProviderUsage } from '@shared/provider-usage'
import { createMainLogger } from '../../logger'
import { fetchClaudeUsage } from './claude-usage'
import { fetchCodexUsage } from './codex-usage'

export { disposeUsageProbes } from './codex-usage'

const log = createMainLogger('provider:usage')

/** Long enough that a double-click is free, short enough to stay truthful. */
const CACHE_TTL_MS = 45_000

const cache = new Map<string, ProviderUsage>()
const inFlight = new Map<string, Promise<ProviderUsage>>()

/**
 * Codex probes spawn a ~260MB binary, so they run one at a time no matter
 * how fast the user clicks down a list of instances.
 */
let codexQueue: Promise<unknown> = Promise.resolve()
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = codexQueue.then(task, task)
  codexQueue = next.catch(() => undefined)
  return next
}

function flat(
  instanceId: string,
  agentType: ProviderUsage['agentType'],
  status: ProviderUsage['status'],
  message: string,
): ProviderUsage {
  return {
    instanceId,
    agentType,
    status,
    plan: null,
    account: null,
    windows: [],
    overage: [],
    message,
    fetchedAtMs: Date.now(),
  }
}

async function probe(id: string, agentType: ProviderUsage['agentType']): Promise<ProviderUsage> {
  const instance = getProviderInstanceFull(id)
  if (!instance) return flat(id, agentType, 'unsupported', 'Instance not found.')

  const env = resolveInstanceEnv(instance)

  if (instance.agentType === 'claude-code') {
    return fetchClaudeUsage(id, env, instance.oauthDir)
  }

  if (instance.agentType === 'codex') {
    const bin = findCodexPath()
    if (!bin) {
      return flat(id, 'codex', 'error', 'codex binary not found - install Codex and ensure it is on PATH.')
    }
    return runExclusive(() => fetchCodexUsage(id, env, bin, instance.oauthDir))
  }

  if (instance.agentType === 'opencode') {
    return flat(id, 'opencode', 'not-applicable',
      'OpenCode runs on your own provider API keys, so there is no subscription quota to report.')
  }

  return flat(id, instance.agentType, 'unsupported', `Usage reporting is not available for ${instance.agentType}.`)
}

/**
 * Drop a cached reading. Called when an instance is edited or deleted, since
 * changing its oauth dir points it at a different credential and the old
 * numbers would otherwise stand for up to the TTL.
 */
export function invalidateUsage(id?: string): void {
  if (id === undefined) {
    cache.clear()
    return
  }
  cache.delete(id)
}

export async function fetchInstanceUsage(id: string, opts?: { force?: boolean }): Promise<ProviderUsage> {
  if (opts?.force) cache.delete(id)
  else {
    const cached = cache.get(id)
    if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached
  }

  // Deliberately shared even for a forced refresh: two probes against the same
  // credential would race, and the in-flight one is already fresh.
  const existing = inFlight.get(id)
  if (existing) return existing

  // Resolved up front so a probe that throws can still report the right kind.
  const agentType = getProviderInstanceFull(id)?.agentType ?? 'claude-code'

  const task = probe(id, agentType)
    .then((result) => {
      cache.set(id, result)
      return result
    })
    .catch((err): ProviderUsage => {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`usage probe threw for ${id}: ${message}`)
      return flat(id, agentType, 'error', message)
    })
    .finally(() => {
      inFlight.delete(id)
    })

  inFlight.set(id, task)
  return task
}
