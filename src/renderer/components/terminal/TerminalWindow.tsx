import { useState, useCallback, useRef, useEffect } from 'react'
import { useTerminalStore } from '../../stores/terminal-store'
import { useAgentStore } from '../../stores/agent-store'
import { TerminalPane } from './TerminalPane'
import { destroyTerminal, focusTerminal } from '../../services/terminal-registry'
import type { WindowState, PaneState } from '../../stores/terminal-store'

interface TerminalWindowProps {
  sessionId: string
  window: WindowState
  panes: Record<string, PaneState>
  isActiveWindow: boolean
  onFocusWindow: () => void
}

/**
 * A spatial window slot. Renders its tab bar (if >1 pane) + the active pane's xterm.
 * Other panes in the stack stay alive in the terminal-registry.
 */
export function TerminalWindow({ sessionId, window, panes, isActiveWindow, onFocusWindow }: TerminalWindowProps) {
  const activePaneId = window.activePaneId
  const activePane = panes[activePaneId]
  const { setActivePane, removePane, removeWindow, addPaneToWindow } = useTerminalStore()

  const [tabsOpen, setTabsOpen] = useState(false)
  const tabsBtnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close popover on outside click
  useEffect(() => {
    if (!tabsOpen) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (tabsBtnRef.current?.contains(target)) return
      setTabsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [tabsOpen])

  const handleClosePane = useCallback((paneId: string) => {
    destroyTerminal(paneId)
    removePane(sessionId, paneId)
  }, [sessionId, removePane])

  const handleSwitchPane = useCallback((paneId: string) => {
    setActivePane(sessionId, paneId)
    setTabsOpen(false)
    setTimeout(() => focusTerminal(paneId), 20)
  }, [sessionId, setActivePane])

  const handleNewPane = useCallback(() => {
    const count = window.paneIds.length + 1
    const cwd = useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.projectPath
    const newId = addPaneToWindow(sessionId, window.id, { label: `Terminal ${count}`, cwd })
    if (newId) setTimeout(() => focusTerminal(newId), 80)
  }, [sessionId, window.id, window.paneIds.length, addPaneToWindow])

  const handleCloseWindow = useCallback(() => {
    // Destroy all PTYs in this window
    for (const pid of window.paneIds) destroyTerminal(pid)
    removeWindow(sessionId, window.id)
  }, [sessionId, window.id, window.paneIds, removeWindow])

  if (!activePane) return null

  const paneCount = window.paneIds.length
  const tabIndicator = paneCount > 1
    ? `${window.paneIds.indexOf(activePaneId) + 1}/${paneCount}`
    : null

  return (
    <div
      onClick={onFocusWindow}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        borderRadius: 'var(--radius)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '3px 8px',
          background: isActiveWindow ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '11px',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <span style={{
          width: '5px',
          height: '5px',
          borderRadius: '50%',
          background:
            activePane.status === 'running' ? 'var(--success)'
            : activePane.status === 'error' ? 'var(--error)'
            : 'var(--text-muted)',
          flexShrink: 0,
        }} />

        <span style={{
          flex: 1,
          color: isActiveWindow ? 'var(--text-primary)' : 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activePane.label}
        </span>

        {/* Tab count + dropdown */}
        {tabIndicator && (
          <button
            ref={tabsBtnRef}
            onClick={(e) => { e.stopPropagation(); setTabsOpen(!tabsOpen) }}
            title="Show tabs"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '2px',
              padding: '1px 5px',
              borderRadius: '3px',
              border: '1px solid var(--border)',
              background: 'var(--bg-primary)',
              color: 'var(--text-secondary)',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
            }}
          >
            {tabIndicator} <span style={{ fontSize: '8px' }}>{tabsOpen ? '\u25B4' : '\u25BE'}</span>
          </button>
        )}

        {/* New pane (tab) */}
        <button
          onClick={(e) => { e.stopPropagation(); handleNewPane() }}
          title={'New tab (\u2318\\)'}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '0 3px',
            fontSize: '13px',
            lineHeight: 1,
          }}
        >
          +
        </button>

        {/* Close active pane (or window if last) */}
        <button
          onClick={(e) => { e.stopPropagation(); handleClosePane(activePaneId) }}
          title={paneCount > 1 ? 'Close tab (\u2318W)' : 'Close window (\u2318W)'}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '0 3px',
            fontSize: '14px',
            lineHeight: 1,
          }}
        >
          &times;
        </button>

        {/* Tabs popover */}
        {tabsOpen && (
          <div
            ref={popoverRef}
            className="sb-floating-surface"
            style={{
              position: 'absolute',
              top: '100%',
              right: '8px',
              marginTop: '2px',
              minWidth: '180px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              zIndex: 100,
              overflow: 'hidden',
              padding: '4px 0',
            }}
          >
            {window.paneIds.map((pid, idx) => {
              const p = panes[pid]
              if (!p) return null
              const active = pid === activePaneId
              return (
                <div
                  key={pid}
                  onClick={(e) => { e.stopPropagation(); handleSwitchPane(pid) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 10px',
                    background: active ? 'var(--bg-active)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '11.5px',
                  }}
                  onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
                  onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '9.5px',
                    color: 'var(--text-muted)',
                    width: '14px',
                    flexShrink: 0,
                  }}>
                    {idx + 1}
                  </span>
                  <span style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {p.label}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleClosePane(pid)
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: '0 3px',
                      fontSize: '11px',
                      lineHeight: 1,
                    }}
                    title="Close tab"
                  >
                    &times;
                  </button>
                </div>
              )
            })}
            <div style={{
              borderTop: '1px solid var(--border)',
              padding: '4px 10px',
              fontSize: '10px',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}>
              {'\u2318\u21E7]/[' + ' to cycle \u00b7 \u2318\\ new \u00b7 \u2318W close'}
            </div>
          </div>
        )}
      </div>

      {/* Active pane's xterm — all panes live in the registry; only active one mounts DOM */}
      <div style={{ flex: '1 1 0%', position: 'relative', minHeight: 0 }}>
        {window.paneIds.map((pid) => {
          const pane = panes[pid]
          if (!pane) return null
          const visible = pid === activePaneId
          return (
            <div
              key={pid}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: visible ? 'visible' : 'hidden',
                pointerEvents: visible ? 'auto' : 'none',
              }}
            >
              <TerminalPane
                id={pid}
                sessionId={sessionId}
                label={pane.label}
                status={pane.status}
                isActive={visible && isActiveWindow}
                cwd={pane.cwd}
                command={pane.command}
                wait_for={pane.wait_for}
                stale={pane.stale}
                onClose={() => handleClosePane(pid)}
                onFocus={() => handleSwitchPane(pid)}
                hideHeader
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
