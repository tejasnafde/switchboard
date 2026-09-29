/**
 * Per-instance subscription usage lookup, behind the Settings "Usage" button.
 *
 * Nothing here writes a credential or refreshes a token itself, and nothing
 * touches a running session. A stale Claude token is refreshed by the Claude
 * CLI (see claude-cli-refresh.ts).
 */

import { getProviderInstanceFull, type ProviderInstanceRow } from '../../db/provider-instances'
import { resolveInstanceEnv } from '../instance-env'
import { findCodexPath } from '../adapters/codex-adapter'
import type { ProviderUsage } from '@shared/provider-usage'
import { createMainLogger } from '../../logger'
import { fetchClaudeUsage } from './claude-usage'
import { forgetClaudeCredentialReads } from './claude-keychain'
import { fetchCodexUsage } from './codex-usage'

export { disposeUsageProbes } from './codex-usage'

const log = createMainLogger('provider:usage')

/** Long enough that a double-click is free, short enough to stay truthful. */
const CACHE_TTL_MS = 45_000

const cache = new Map<string, ProviderUsage>()
/** A probe in flight, with how strong a request it answers (see `strength`). */
const inFlight = new Map<string, { task: Promise<ProviderUsage>; strength: number }>()

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

export interface UsageRequestOptions {
  force?: boolean
  /** Claude only: run one minimal CLI turn first so the CLI refreshes a stale token. */
  refreshWithTurn?: boolean
}

/**
 * The instance a usage probe spawns with. Claude and Codex probes apply the
 * stored env overlay (an oauth_dir profile can carry one too, for example
 * ANTHROPIC_BASE_URL); `getProviderInstanceFull` decrypts it only when the
 * row's key list does not prove it empty, because each decrypt can be a
 * keychain prompt on an unsigned macOS build and Accounts reads every
 * instance's usage when it opens. Other kinds never decrypt.
 */
export function usageInstance(id: string): ProviderInstanceRow | null {
  const meta = getProviderInstanceFull(id, { withEnv: false })
  if (!meta) return null
  return meta.agentType === 'claude-code' || meta.agentType === 'codex' ? getProviderInstanceFull(id) ?? meta : meta
}

async function probe(id: string, agentType: ProviderUsage['agentType'], opts: UsageRequestOptions): Promise<ProviderUsage> {
  const instance = usageInstance(id)
  if (!instance) return flat(id, agentType, 'unsupported', 'Instance not found.')

  const env = resolveInstanceEnv(instance)

  if (instance.agentType === 'claude-code') {
    return fetchClaudeUsage(id, env, instance.oauthDir, { force: opts.force, refreshWithTurn: opts.refreshWithTurn })
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
  // Includes a keychain item remembered as holding no credential.
  forgetClaudeCredentialReads(id)
  if (id === undefined) {
    cache.clear()
    return
  }
  cache.delete(id)
}

/** 0 = may be cached, 1 = forced (the Usage refresh), 2 = refresh with a CLI turn. */
function strength(opts: UsageRequestOptions): number {
  if (opts.refreshWithTurn) return 2
  return opts.force ? 1 : 0
}

export async function fetchInstanceUsage(id: string, opts: UsageRequestOptions = {}): Promise<ProviderUsage> {
  const wanted = strength(opts)
  if (wanted > 0) cache.delete(id)
  else {
    const cached = cache.get(id)
    if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached
  }

  // A probe in flight answers any request no stronger than its own. A
  // stronger one waits for it and then runs its own: never two probes at
  // once, since each can be a keychain password prompt, and never an
  // unforced reading handed to a forced request.
  let existing = inFlight.get(id)
  if (existing && existing.strength >= wanted) return existing.task
  while (existing) {
    await Promise.allSettled([existing.task])
    existing = inFlight.get(id)
    if (existing && existing.strength >= wanted) return existing.task
  }

  // Resolved up front so a probe that throws can still report the right kind.
  const agentType = getProviderInstanceFull(id, { withEnv: false })?.agentType ?? 'claude-code'

  const task: Promise<ProviderUsage> = probe(id, agentType, opts)
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
      if (inFlight.get(id)?.task === task) inFlight.delete(id)
    })

  inFlight.set(id, { task, strength: wanted })
  return task
}
