/**
 * Proactive remote-auth banner for SSH-machine sessions.
 *
 * A remote Claude session with no VM credentials used to error only at first
 * send (the START_SESSION backstop throws the login prompt). This banner runs
 * the same check at chat-open via `provider.checkRemoteAuth` and, when the VM
 * isn't logged in, renders a slim non-blocking strip above the chat input with
 * the copyable login command and a Re-check button. It never prevents typing
 * or sending - the START_SESSION backstop still catches any race.
 *
 * Results are cached per (machineId, config-dir segment) in module state so
 * tab-switching doesn't re-probe; Re-check and instance rotation invalidate.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProviderInstanceChannels } from '@shared/ipc-channels'
import type { AgentType } from '@shared/types'
import { useMachineStore } from '../../stores/machine-store'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:remote-auth')

export interface RemoteAuthCheckResult {
  loggedIn: boolean
  loginCommand?: string
  configDir?: string
}

/**
 * Pure banner decision: show only for a remote (non-local machine) Claude
 * session whose completed check says it is NOT logged in. A missing check
 * (still probing, or the probe itself failed - e.g. machine offline) renders
 * nothing.
 */
export function shouldShowRemoteAuthBanner(
  session: { machineId?: string | null; agentType?: AgentType | null } | null | undefined,
  check: RemoteAuthCheckResult | null | undefined,
): boolean {
  if (!session || !check) return false
  if (!session.machineId || session.machineId === 'local') return false
  if (session.agentType !== 'claude-code') return false
  return !check.loggedIn
}

/** Cache key: one auth verdict per (machine, config-dir segment). */
export function remoteAuthCacheKey(machineId: string, configSegment: string | null | undefined): string {
  return `${machineId}::${configSegment ?? '.claude'}`
}

const checkCache = new Map<string, RemoteAuthCheckResult>()

/**
 * Drop cached verdicts for one machine (or all when omitted). Called on
 * Re-check and when a session's provider instance rotates - the new instance
 * may map to a config dir probed earlier under a now-stale verdict.
 */
export function invalidateRemoteAuthCache(machineId?: string): void {
  if (machineId === undefined) {
    checkCache.clear()
    return
  }
  for (const key of checkCache.keys()) {
    if (key.startsWith(`${machineId}::`)) checkCache.delete(key)
  }
}

/**
 * Same derivation the preload startSession path uses: ask the LOCAL backend
 * to resolve the instance's oauth_dir basename (a path segment, not a
 * secret) so the remote check probes the mirrored per-instance config dir.
 */
async function resolveConfigSegment(instanceId: string | undefined): Promise<string | null> {
  return window.api.routing.invokeOn<string | null>(
    'local',
    ProviderInstanceChannels.RESOLVE_OAUTH_DIR,
    'claude-code',
    instanceId,
  )
}

interface RemoteAuthBannerProps {
  sessionId: string | null
  machineId?: string
  agentType: AgentType
  instanceId?: string
}

export function RemoteAuthBanner({ sessionId, machineId, agentType, instanceId }: RemoteAuthBannerProps) {
  const [result, setResult] = useState<RemoteAuthCheckResult | null>(null)
  const [recheckState, setRecheckState] = useState<'idle' | 'checking' | 'success'>('idle')
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const successTimerRef = useRef<number | null>(null)

  const isRemoteClaude = Boolean(sessionId) && Boolean(machineId) && machineId !== 'local' && agentType === 'claude-code'
  // While the machine is disconnected its session-id bindings are wiped, so a
  // probe would silently route to the LOCAL backend and cache a false
  // "logged in". Only probe while connected.
  const machineConnected = useMachineStore((s) => (machineId ? s.connections[machineId] === 'connected' : false))

  // Probe on session open / switch / instance change. Cached verdicts are
  // reused so flipping between tabs doesn't re-hit the machine.
  useEffect(() => {
    setResult(null)
    setRecheckState('idle')
    setCopied(false)
    if (!sessionId || !machineId || !isRemoteClaude || !machineConnected) return
    let cancelled = false
    ;(async () => {
      try {
        const seg = await resolveConfigSegment(instanceId)
        const key = remoteAuthCacheKey(machineId, seg)
        const cached = checkCache.get(key)
        if (cached) {
          if (!cancelled) setResult(cached)
          return
        }
        const res = await window.api.provider.checkRemoteAuth(sessionId, seg ?? undefined)
        checkCache.set(key, res)
        if (!cancelled) setResult(res)
      } catch (err) {
        // Probe failure (machine offline, tunnel not up) renders nothing -
        // the START_SESSION backstop still guards the actual send.
        log.warn('remote auth preflight failed', { sessionId, machineId, err })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, machineId, instanceId, isRemoteClaude, machineConnected])

  // Clear feedback timers on unmount so a dead component never sets state.
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current)
  }, [])

  const handleCopy = useCallback(async () => {
    const cmd = result?.loginCommand
    if (!cmd) return
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      log.warn('clipboard write failed', err)
    }
  }, [result?.loginCommand])

  const handleRecheck = useCallback(async () => {
    if (!sessionId || !machineId || !machineConnected || recheckState === 'checking') return
    setRecheckState('checking')
    try {
      const seg = await resolveConfigSegment(instanceId)
      checkCache.delete(remoteAuthCacheKey(machineId, seg))
      const res = await window.api.provider.checkRemoteAuth(sessionId, seg ?? undefined)
      checkCache.set(remoteAuthCacheKey(machineId, seg), res)
      if (res.loggedIn) {
        // Brief "Logged in" confirmation, then dismiss (setResult flips
        // shouldShowRemoteAuthBanner to false).
        setRecheckState('success')
        if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current)
        successTimerRef.current = window.setTimeout(() => {
          setResult(res)
          setRecheckState('idle')
        }, 1200)
      } else {
        setResult(res)
        setRecheckState('idle')
      }
    } catch (err) {
      log.warn('remote auth re-check failed', { sessionId, machineId, err })
      setRecheckState('idle')
    }
  }, [sessionId, machineId, instanceId, recheckState, machineConnected])

  if (!shouldShowRemoteAuthBanner({ machineId, agentType }, result)) return null

  return (
    <div
      data-remote-auth-banner="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '6px 16px',
        fontSize: '12px',
        color: 'var(--text-primary)',
        background: 'rgba(245, 158, 11, 0.08)',
        borderTop: '1px solid rgba(245, 158, 11, 0.35)',
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ color: '#f59e0b', fontSize: '13px', lineHeight: 1 }}>⚠</span>
      <span>This machine isn't logged in to Claude</span>
      {result?.loginCommand && (
        <button
          onClick={handleCopy}
          title="Click to copy"
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '11px',
            color: 'var(--text-primary)',
            background: 'var(--bg-secondary, rgba(0, 0, 0, 0.2))',
            border: '1px solid var(--border, rgba(127, 127, 127, 0.3))',
            borderRadius: '4px',
            padding: '2px 8px',
            cursor: 'pointer',
            maxWidth: '420px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {copied ? 'Copied' : result.loginCommand}
        </button>
      )}
      <button
        onClick={handleRecheck}
        disabled={recheckState === 'checking'}
        style={{
          marginLeft: 'auto',
          fontSize: '11px',
          color: recheckState === 'success' ? '#4ade80' : 'var(--text-muted)',
          background: 'none',
          border: '1px solid var(--border, rgba(127, 127, 127, 0.3))',
          borderRadius: '4px',
          padding: '2px 8px',
          cursor: recheckState === 'checking' ? 'default' : 'pointer',
          flexShrink: 0,
        }}
      >
        {recheckState === 'checking' ? 'Checking…' : recheckState === 'success' ? 'Logged in ✓' : 'Re-check'}
      </button>
    </div>
  )
}
