import { useEffect } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useProviderInstanceStore } from '../stores/provider-instance-store'
import { agentLabel, defaultInstanceId } from '@shared/types'

/**
 * Bottom status bar.
 *
 * Shows at-a-glance state across the whole app:
 *   - Active project name
 *   - Active session's agent type + status (thinking / idle / running / error)
 *   - Total terminal pane count for the active session
 *
 * Kept deliberately thin — this is the last persistent surface besides the
 * titlebar. Avoid putting controls here; use the command palette or chat
 * footer for actions.
 */
export function StatusBar() {
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const session = useAgentStore((s) => s.sessions.find((x) => x.id === activeSessionId))
  const terminalSessionId = useTerminalStore((s) => s.activeSessionId)
  const terminalPaneCount = useTerminalStore((s) => {
    const sid = terminalSessionId
    if (!sid) return 0
    // getAllPaneIds walks rows → windows → panes
    try { return s.getAllPaneIds(sid).length } catch { return 0 }
  })

  const projectName = session?.projectPath?.split('/').pop() ?? ''
  const label = agentLabel(session?.type)

  // Provider instance (named credential set) for the active session.
  // Falls back to "<kind>-default" — matches the resolver in main.
  // Only show the label when there's >1 instance for this kind so the
  // status bar stays uncluttered for single-account users.
  const allInstances = useProviderInstanceStore((s) => s.instances)
  const instancesLoaded = useProviderInstanceStore((s) => s.loaded)
  const refreshInstances = useProviderInstanceStore((s) => s.refresh)
  useEffect(() => {
    if (!instancesLoaded) void refreshInstances()
  }, [instancesLoaded, refreshInstances])
  const sameKindInstances = session
    ? allInstances.filter((i) => i.agentType === session.type && i.enabled)
    : []
  const resolvedInstance = session
    ? (allInstances.find((i) => i.id === session.instanceId)
        ?? allInstances.find((i) => i.id === defaultInstanceId(session.type)))
    : undefined
  const showInstance = sameKindInstances.length > 1 && resolvedInstance
  const status = session?.status ?? 'idle'
  const statusColor =
    status === 'running' || status === 'thinking' ? 'var(--accent)'
    : status === 'error' ? 'var(--error, #f85149)'
    : status === 'exited' ? 'var(--text-muted)'
    : 'var(--success, #3fb950)'

  return (
    <div
      style={{
        height: '22px',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '0 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        fontSize: '10.5px',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
        userSelect: 'none',
      }}
    >
      {/* Project */}
      {projectName && (
        <span title={session?.projectPath}>
          <span style={{ color: 'var(--text-secondary)' }}>{projectName}</span>
        </span>
      )}

      {/* Divider */}
      {projectName && session && <span style={{ opacity: 0.4 }}>·</span>}

      {/* Agent + status */}
      {session && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: statusColor,
            animation: status === 'running' || status === 'thinking'
              ? 'pulse 1.4s ease-in-out infinite'
              : undefined,
          }} />
          <span>{label}</span>
          <span style={{ opacity: 0.6 }}>{status}</span>
        </span>
      )}

      {/* Instance label (only when user has multiple instances for this kind). */}
      {showInstance && resolvedInstance && (
        <>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }} title={`Provider instance: ${resolvedInstance.displayName}`}>
            <span style={{
              display: 'inline-block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: resolvedInstance.accentColor ?? 'var(--accent)',
            }} />
            <span style={{ color: 'var(--text-secondary)' }}>{resolvedInstance.displayName}</span>
          </span>
        </>
      )}

      <span style={{ flex: 1 }} />

      {/* Cumulative session cost (ACP adapters only — currently OpenCode).
          Hidden when zero or undefined so Claude/Codex sessions stay clean. */}
      {typeof session?.costUsd === 'number' && session.costUsd > 0 && (
        <span title="Cumulative session cost reported by the agent">
          ${session.costUsd < 0.01 ? session.costUsd.toFixed(4) : session.costUsd.toFixed(3)}
        </span>
      )}

      {typeof session?.costUsd === 'number' && session.costUsd > 0 && terminalPaneCount > 0 && (
        <span style={{ opacity: 0.4 }}>·</span>
      )}

      {/* Terminal count */}
      {terminalPaneCount > 0 && (
        <span title="Terminal panes in the active session">
          {terminalPaneCount} {terminalPaneCount === 1 ? 'terminal' : 'terminals'}
        </span>
      )}
    </div>
  )
}
