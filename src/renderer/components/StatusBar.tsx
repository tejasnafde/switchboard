import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { agentLabel } from '@shared/types'

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

      <span style={{ flex: 1 }} />

      {/* Terminal count */}
      {terminalPaneCount > 0 && (
        <span title="Terminal panes in the active session">
          {terminalPaneCount} {terminalPaneCount === 1 ? 'terminal' : 'terminals'}
        </span>
      )}
    </div>
  )
}
