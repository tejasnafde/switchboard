import { Fragment, useCallback, useRef } from 'react'
import { useTerminalStore } from '../../stores/terminal-store'
import { useAgentStore } from '../../stores/agent-store'
import { TerminalWindow } from './TerminalWindow'
import { PaneResizeHandle } from './PaneResizeHandle'
import { focusTerminal } from '../../services/terminal-registry'
import { LaunchConfigPicker } from './LaunchConfigPicker'
import { sessionExecutionRootPath } from '../../services/execution-root'
import { terminalCountLabel } from '@shared/format'

/** Where a new pane opens. The session's CURRENT root, so a followed
 *  worktree is picked up instead of the parent checkout. */
function getSessionCwd(sessionId: string | null): string | undefined {
  return sessionExecutionRootPath(sessionId)
}

/**
 * TerminalGrid - rows of windows. Each window holds stacked panes (tabs).
 */
export function TerminalStrip() {
  const activeSessionId = useTerminalStore((s) => s.activeSessionId)
  const layout = useTerminalStore((s) =>
    s.activeSessionId ? s.getLayout(s.activeSessionId) : null
  )
  const { addWindow, splitActiveWindow, addPaneToActiveWindow, setActiveWindow } = useTerminalStore()

  // Flex ratios for rows (row resizing)
  const rowRatiosRef = useRef<Map<string, number>>(new Map())
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  // Flex ratios for windows within a row
  const windowRatiosRef = useRef<Map<string, number>>(new Map())
  const windowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const registerRowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowElementsRef.current.set(id, el)
    else rowElementsRef.current.delete(id)
  }, [])

  const registerWindowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) windowElementsRef.current.set(id, el)
    else windowElementsRef.current.delete(id)
  }, [])

  const newWindowInRow = useCallback(() => {
    if (!activeSessionId) return
    const ids = useTerminalStore.getState().getAllWindowIds(activeSessionId)
    const cwd = getSessionCwd(activeSessionId)
    const ref = splitActiveWindow(activeSessionId, 'row', { label: `Terminal ${ids.length + 1}`, cwd })
    if (ref) setTimeout(() => focusTerminal(ref.paneId), 80)
  }, [activeSessionId, splitActiveWindow])

  const newWindowInColumn = useCallback(() => {
    if (!activeSessionId) return
    const ids = useTerminalStore.getState().getAllWindowIds(activeSessionId)
    const cwd = getSessionCwd(activeSessionId)
    const ref = splitActiveWindow(activeSessionId, 'column', { label: `Terminal ${ids.length + 1}`, cwd })
    if (ref) setTimeout(() => focusTerminal(ref.paneId), 80)
  }, [activeSessionId, splitActiveWindow])

  const newPaneInActiveWindow = useCallback(() => {
    if (!activeSessionId) return
    const ids = useTerminalStore.getState().getAllPaneIds(activeSessionId)
    const cwd = getSessionCwd(activeSessionId)
    const pid = addPaneToActiveWindow(activeSessionId, { label: `Terminal ${ids.length + 1}`, cwd })
    if (pid) setTimeout(() => focusTerminal(pid), 80)
  }, [activeSessionId, addPaneToActiveWindow])

  const handleFocusWindow = useCallback((windowId: string) => {
    if (!activeSessionId) return
    setActiveWindow(activeSessionId, windowId)
    const pid = useTerminalStore.getState().getLayout(activeSessionId).windows[windowId]?.activePaneId
    if (pid) focusTerminal(pid)
  }, [activeSessionId, setActiveWindow])

  // Row-to-row resize (vertical drag)
  const makeRowResizeHandler = useCallback((topRowId: string, bottomRowId: string) => {
    return (deltaPx: number) => {
      const topEl = rowElementsRef.current.get(topRowId)
      const bottomEl = rowElementsRef.current.get(bottomRowId)
      if (!topEl || !bottomEl) return
      const topRatio = rowRatiosRef.current.get(topRowId) ?? 1
      const bottomRatio = rowRatiosRef.current.get(bottomRowId) ?? 1
      const total = topRatio + bottomRatio
      const combined = topEl.offsetHeight + bottomEl.offsetHeight
      if (combined === 0) return
      const ratioDelta = (deltaPx / combined) * total
      const min = 0.15
      const newTop = Math.max(min, Math.min(total - min, topRatio + ratioDelta))
      const newBottom = total - newTop
      rowRatiosRef.current.set(topRowId, newTop)
      rowRatiosRef.current.set(bottomRowId, newBottom)
      topEl.style.flex = `${newTop} 1 0%`
      bottomEl.style.flex = `${newBottom} 1 0%`
    }
  }, [])

  // Window-to-window resize within a row (horizontal drag)
  const makeWindowResizeHandler = useCallback((leftId: string, rightId: string) => {
    return (deltaPx: number) => {
      const leftEl = windowElementsRef.current.get(leftId)
      const rightEl = windowElementsRef.current.get(rightId)
      if (!leftEl || !rightEl) return
      const leftRatio = windowRatiosRef.current.get(leftId) ?? 1
      const rightRatio = windowRatiosRef.current.get(rightId) ?? 1
      const total = leftRatio + rightRatio
      const combined = leftEl.offsetWidth + rightEl.offsetWidth
      if (combined === 0) return
      const ratioDelta = (deltaPx / combined) * total
      const min = 0.15
      const newLeft = Math.max(min, Math.min(total - min, leftRatio + ratioDelta))
      const newRight = total - newLeft
      windowRatiosRef.current.set(leftId, newLeft)
      windowRatiosRef.current.set(rightId, newRight)
      leftEl.style.flex = `${newLeft} 1 0%`
      rightEl.style.flex = `${newRight} 1 0%`
    }
  }, [])

  const handleResizeEnd = useCallback(() => {}, [])

  const rows = layout?.rows ?? []
  const windows = layout?.windows ?? {}
  const panes = layout?.panes ?? {}
  const activeWindowId = layout?.activeWindowId ?? null
  const hasAny = rows.length > 0
  const paneCount = rows.reduce((n, row) => n + row.windowIds.reduce((m, wid) => m + (windows[wid]?.paneIds.length ?? 0), 0), 0)

  return (
    <div
      data-terminal-strip
      data-session-id={activeSessionId ?? undefined}
      className="flex h-full w-full flex-col overflow-hidden bg-[var(--bg-primary)]"
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-[4px] border-b border-[var(--border)] bg-[var(--bg-secondary)] px-[8px] py-[3px]">
        <span className="text-[11px] font-[600] text-[var(--text-muted)]">
          TERMINAL
        </span>
        <LaunchConfigPicker />
        <div className="flex-1" />
        {paneCount > 0 && (
          <span title="Terminal panes in this chat" className="mr-[4px] text-[11px] text-[var(--text-muted)]">
            {terminalCountLabel(paneCount)}
          </span>
        )}
        {activeSessionId && (
          <>
            <button
              onClick={hasAny ? newWindowInRow : () => {
                const ids = useTerminalStore.getState().getAllWindowIds(activeSessionId)
                const cwd = getSessionCwd(activeSessionId)
                const r = addWindow(activeSessionId, { label: `Terminal ${ids.length + 1}`, cwd })
                setTimeout(() => focusTerminal(r.paneId), 80)
              }}
              title="New window (⌘T)"
              className={toolbarBtn}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </button>
            <button onClick={newWindowInColumn} title="New window below (⌘⇧T)" className={toolbarBtn}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
            </button>
            <button onClick={newPaneInActiveWindow} title={'New tab in active window (⌘\\)'} className={toolbarBtn}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Grid area */}
      <div className="flex min-h-0 flex-[1_1_0%] flex-col overflow-hidden">
        {!hasAny && (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
            {activeSessionId
              ? 'No terminals open. Press ⌘T to create a window.'
              : 'Select a chat to open terminals.'}
          </div>
        )}

        {rows.map((row, rowIndex) => (
          <Fragment key={row.id}>
            {rowIndex > 0 && (
              <PaneResizeHandle
                direction="row"
                onResize={makeRowResizeHandler(rows[rowIndex - 1].id, row.id)}
                onResizeEnd={handleResizeEnd}
              />
            )}

            <div
              ref={(el) => registerRowRef(row.id, el)}
              className="flex min-h-0 flex-row overflow-hidden"
              style={{ flex: `${rowRatiosRef.current.get(row.id) ?? 1} 1 0%` }}
            >
              {row.windowIds.map((wid, colIndex) => {
                const win = windows[wid]
                if (!win) return null
                return (
                  <Fragment key={wid}>
                    {colIndex > 0 && (
                      <PaneResizeHandle
                        direction="column"
                        onResize={makeWindowResizeHandler(row.windowIds[colIndex - 1], wid)}
                        onResizeEnd={handleResizeEnd}
                      />
                    )}
                    <div
                      ref={(el) => registerWindowRef(wid, el)}
                      className="flex min-h-0 min-w-0 flex-col overflow-hidden"
                      style={{ flex: `${windowRatiosRef.current.get(wid) ?? 1} 1 0%` }}
                    >
                      <TerminalWindow
                        sessionId={activeSessionId!}
                        window={win}
                        panes={panes}
                        isActiveWindow={wid === activeWindowId}
                        onFocusWindow={() => handleFocusWindow(wid)}
                      />
                    </div>
                  </Fragment>
                )
              })}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

const toolbarBtn = 'flex cursor-pointer items-center border-0 bg-transparent px-[4px] py-[2px] leading-none text-[var(--text-muted)]'
