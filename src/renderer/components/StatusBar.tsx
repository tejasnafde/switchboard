import { formatCostUsd } from '@shared/format'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useLayoutStore } from '../stores/layout-store'

/**
 * Bottom status bar.
 *
 * Shows at-a-glance state across the whole app:
 *   - Active project name
 *   - Total terminal pane count for the active session
 *
 * Kept deliberately thin - this is the last persistent surface besides the
 * titlebar. Avoid putting controls here; use the command palette or chat
 * footer for actions.
 */
export function StatusBar() {
  const activeSessionId = useLayoutStore((s) =>
    s.focusedChatSlot === 'secondary' && s.secondarySessionId
      ? s.secondarySessionId
      : s.primarySessionId,
  )
  const session = useAgentStore((s) => s.sessions.find((x) => x.id === activeSessionId))
  const terminalSessionId = useTerminalStore((s) => s.activeSessionId)
  const terminalPaneCount = useTerminalStore((s) => {
    const sid = terminalSessionId
    if (!sid) return 0
    // getAllPaneIds walks rows → windows → panes
    try { return s.getAllPaneIds(sid).length } catch { return 0 }
  })

  const projectName = session?.projectPath?.split('/').pop() ?? ''

  return (
    <div
      data-status-bar
      data-session-id={activeSessionId ?? undefined}
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

      <span style={{ flex: 1 }} />

      {/* Cumulative session cost (ACP adapters only - currently OpenCode).
          Hidden when zero or undefined so Claude/Codex sessions stay clean. */}
      {typeof session?.costUsd === 'number' && session.costUsd > 0 && (
        <span title="Cumulative session cost reported by the agent">
          {formatCostUsd(session.costUsd)}
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
