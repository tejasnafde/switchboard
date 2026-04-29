import { create } from 'zustand'
import type { TerminalStatus } from '@shared/types'
import { destroyTerminal } from '../services/terminal-registry'

// ─── Types ─────────────────────────────────────────────────────────

/**
 * Pane = a single terminal (one PTY + one xterm instance).
 * Stacked inside a Window — only the active pane is visible.
 */
export interface PaneState {
  id: string
  label: string
  status: TerminalStatus
  sessionId: string
  cwd?: string
  command?: string
  wait_for?: string
  /**
   * True when the pane was restored from a previous session's saved layout
   * and hasn't been manually started yet. TerminalPane renders a
   * "Click to start" overlay so we don't silently auto-respawn long-running
   * processes (e.g. `npm run dev`) on every app launch.
   */
  stale?: boolean
}

/**
 * Window = a spatial slot in the grid (tmux pane).
 * Holds an ordered stack of Panes (tabs). Only `activePaneId` is rendered.
 */
export interface WindowState {
  id: string
  paneIds: string[]
  activePaneId: string
}

export interface RowState {
  id: string
  windowIds: string[]
}

export interface SessionLayout {
  rows: RowState[]
  windows: Record<string, WindowState>
  panes: Record<string, PaneState>
  activeWindowId: string | null
}

interface PaneOptions {
  label: string
  cwd?: string
  command?: string
  wait_for?: string
  /** Restored from saved layout — pane starts in a "stale" state awaiting user confirmation. */
  stale?: boolean
}

type SplitDirection = 'row' | 'column' // row = same row (right), column = new row (below)

// ─── Empty layout constant ─────────────────────────────────────────

const EMPTY_LAYOUT: SessionLayout = { rows: [], windows: {}, panes: {}, activeWindowId: null }

let paneCounter = 0
function genPaneId(): string {
  return `pane_${Date.now()}_${++paneCounter}`
}

let windowCounter = 0
function genWindowId(): string {
  return `win_${Date.now()}_${++windowCounter}`
}

let rowCounter = 0
function genRowId(): string {
  return `row_${Date.now()}_${++rowCounter}`
}

function makePane(sessionId: string, opts: PaneOptions): PaneState {
  return {
    id: genPaneId(),
    label: opts.label,
    status: 'running',
    sessionId,
    cwd: opts.cwd,
    command: opts.command,
    wait_for: opts.wait_for,
    stale: opts.stale ?? false,
  }
}

function activePaneInWindow(layout: SessionLayout): string | null {
  if (!layout.activeWindowId) return null
  return layout.windows[layout.activeWindowId]?.activePaneId ?? null
}

// ─── Store ─────────────────────────────────────────────────────────

interface TerminalStore {
  layouts: Record<string, SessionLayout>
  /**
   * Per-session workspace-template selection. Set when the session
   * hydrates from a named template; surfaced by `TemplatePicker` and
   * persisted into `session_layouts.template_name`.
   */
  templateNames: Record<string, string>
  /** Deprecated — kept for backward compat in older callers */
  globalActivePaneId: string | null
  activeSessionId: string | null

  // Queries
  getLayout: (sessionId: string) => SessionLayout
  /** Flatten all panes across all windows (row-major, then tab order) */
  getAllPaneIds: (sessionId: string) => string[]
  /** Windows in row-major order */
  getAllWindowIds: (sessionId: string) => string[]
  /** Current active pane (the active tab within the active window) */
  getActivePaneId: (sessionId: string) => string | null

  // Window management (spatial)
  addWindow: (sessionId: string, options: PaneOptions) => { windowId: string; paneId: string }
  splitActiveWindow: (sessionId: string, direction: SplitDirection, options: PaneOptions) => { windowId: string; paneId: string } | null
  removeWindow: (sessionId: string, windowId: string) => void
  setActiveWindow: (sessionId: string, windowId: string) => void
  focusWindowByIndex: (sessionId: string, index: number) => void
  focusDirection: (sessionId: string, dir: 'left' | 'right' | 'up' | 'down') => void

  // Pane management (tabs within a window)
  addPaneToActiveWindow: (sessionId: string, options: PaneOptions) => string | null
  addPaneToWindow: (sessionId: string, windowId: string, options: PaneOptions) => string | null
  removePane: (sessionId: string, paneId: string) => void
  setActivePane: (sessionId: string, paneId: string) => void
  /** Cycle to next/prev tab in the active window */
  cyclePane: (sessionId: string, dir: 'next' | 'prev') => void

  // Metadata
  updatePaneLabel: (sessionId: string, paneId: string, label: string) => void
  updatePaneStatus: (sessionId: string, paneId: string, status: TerminalStatus) => void
  /** Clear the `stale` flag on a pane — flips it from "awaiting start" to live. */
  markPaneStarted: (sessionId: string, paneId: string) => void

  // Session lifecycle
  setActiveSession: (sessionId: string | null) => void
  clearSessionLayout: (sessionId: string) => void

  // Template tracking — used by the per-chat picker chip
  getSessionTemplateName: (sessionId: string) => string | null
  setSessionTemplateName: (sessionId: string, name: string | null) => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  layouts: {},
  templateNames: {},
  globalActivePaneId: null,
  activeSessionId: null,

  // ── Queries ──────────────────────────────────────────────────

  getLayout: (sessionId) => get().layouts[sessionId] ?? EMPTY_LAYOUT,

  getAllPaneIds: (sessionId) => {
    const layout = get().getLayout(sessionId)
    const ids: string[] = []
    for (const row of layout.rows) {
      for (const wid of row.windowIds) {
        const win = layout.windows[wid]
        if (win) ids.push(...win.paneIds)
      }
    }
    return ids
  },

  getAllWindowIds: (sessionId) => {
    const layout = get().getLayout(sessionId)
    const ids: string[] = []
    for (const row of layout.rows) ids.push(...row.windowIds)
    return ids
  },

  getActivePaneId: (sessionId) => activePaneInWindow(get().getLayout(sessionId)),

  // ── Window management ────────────────────────────────────────

  addWindow: (sessionId, options) => {
    const pane = makePane(sessionId, options)
    const windowId = genWindowId()

    set((state) => {
      const prev = state.layouts[sessionId] ?? EMPTY_LAYOUT
      const newWin: WindowState = { id: windowId, paneIds: [pane.id], activePaneId: pane.id }

      let rows: RowState[]
      if (prev.rows.length === 0) {
        rows = [{ id: genRowId(), windowIds: [windowId] }]
      } else {
        // Add to last row
        rows = prev.rows.map((r, i) =>
          i === prev.rows.length - 1 ? { ...r, windowIds: [...r.windowIds, windowId] } : r
        )
      }

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            rows,
            windows: { ...prev.windows, [windowId]: newWin },
            panes: { ...prev.panes, [pane.id]: pane },
            activeWindowId: windowId,
          },
        },
      }
    })

    return { windowId, paneId: pane.id }
  },

  splitActiveWindow: (sessionId, direction, options) => {
    const layout = get().getLayout(sessionId)
    const activeWindowId = layout.activeWindowId
    if (!activeWindowId || layout.rows.length === 0) {
      return get().addWindow(sessionId, options)
    }

    const pane = makePane(sessionId, options)
    const windowId = genWindowId()

    // Find the row containing the active window
    const rowIndex = layout.rows.findIndex((r) => r.windowIds.includes(activeWindowId))
    if (rowIndex === -1) return get().addWindow(sessionId, options)

    set((state) => {
      const prev = state.layouts[sessionId]!
      const newWin: WindowState = { id: windowId, paneIds: [pane.id], activePaneId: pane.id }

      let rows: RowState[]
      if (direction === 'row') {
        // Same row — insert immediately after the active window
        rows = prev.rows.map((r, i) => {
          if (i !== rowIndex) return r
          const activeIdx = r.windowIds.indexOf(activeWindowId)
          const next = [...r.windowIds]
          next.splice(activeIdx + 1, 0, windowId)
          return { ...r, windowIds: next }
        })
      } else {
        // column — new row right after the active row
        const newRow: RowState = { id: genRowId(), windowIds: [windowId] }
        rows = [...prev.rows.slice(0, rowIndex + 1), newRow, ...prev.rows.slice(rowIndex + 1)]
      }

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            rows,
            windows: { ...prev.windows, [windowId]: newWin },
            panes: { ...prev.panes, [pane.id]: pane },
            activeWindowId: windowId,
          },
        },
      }
    })

    return { windowId, paneId: pane.id }
  },

  removeWindow: (sessionId, windowId) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev) return state
      const win = prev.windows[windowId]
      if (!win) return state

      // Delete all panes belonging to this window
      const panes = { ...prev.panes }
      for (const pid of win.paneIds) delete panes[pid]

      // Remove the window from its row
      const rows = prev.rows
        .map((r) => ({ ...r, windowIds: r.windowIds.filter((w) => w !== windowId) }))
        .filter((r) => r.windowIds.length > 0)

      const { [windowId]: _removed, ...windows } = prev.windows

      // Update activeWindowId if it pointed at the removed window
      let activeWindowId = prev.activeWindowId
      if (activeWindowId === windowId) {
        const firstWindowId = rows[0]?.windowIds[0] ?? null
        activeWindowId = firstWindowId
      }

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: { rows, windows, panes, activeWindowId },
        },
      }
    })
  },

  setActiveWindow: (sessionId, windowId) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev || !prev.windows[windowId]) return state
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: { ...prev, activeWindowId: windowId },
        },
      }
    })
  },

  focusWindowByIndex: (sessionId, index) => {
    const ids = get().getAllWindowIds(sessionId)
    if (index < 0 || index >= ids.length) return
    get().setActiveWindow(sessionId, ids[index])
  },

  focusDirection: (sessionId, dir) => {
    const layout = get().getLayout(sessionId)
    const activeId = layout.activeWindowId
    if (!activeId) return

    const rowIdx = layout.rows.findIndex((r) => r.windowIds.includes(activeId))
    if (rowIdx === -1) return
    const row = layout.rows[rowIdx]
    const colIdx = row.windowIds.indexOf(activeId)

    let targetId: string | null = null
    if (dir === 'left' && colIdx > 0) {
      targetId = row.windowIds[colIdx - 1]
    } else if (dir === 'right' && colIdx < row.windowIds.length - 1) {
      targetId = row.windowIds[colIdx + 1]
    } else if (dir === 'up' && rowIdx > 0) {
      const prevRow = layout.rows[rowIdx - 1]
      targetId = prevRow.windowIds[Math.min(colIdx, prevRow.windowIds.length - 1)]
    } else if (dir === 'down' && rowIdx < layout.rows.length - 1) {
      const nextRow = layout.rows[rowIdx + 1]
      targetId = nextRow.windowIds[Math.min(colIdx, nextRow.windowIds.length - 1)]
    }
    if (targetId) get().setActiveWindow(sessionId, targetId)
  },

  // ── Pane (tab) management ────────────────────────────────────

  addPaneToActiveWindow: (sessionId, options) => {
    const layout = get().getLayout(sessionId)
    const activeWindowId = layout.activeWindowId
    if (!activeWindowId) {
      const r = get().addWindow(sessionId, options)
      return r.paneId
    }
    return get().addPaneToWindow(sessionId, activeWindowId, options)
  },

  addPaneToWindow: (sessionId, windowId, options) => {
    const pane = makePane(sessionId, options)
    let inserted = false
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev || !prev.windows[windowId]) return state
      const win = prev.windows[windowId]
      inserted = true
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...prev,
            windows: {
              ...prev.windows,
              [windowId]: {
                ...win,
                paneIds: [...win.paneIds, pane.id],
                activePaneId: pane.id,
              },
            },
            panes: { ...prev.panes, [pane.id]: pane },
          },
        },
      }
    })
    return inserted ? pane.id : null
  },

  removePane: (sessionId, paneId) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev || !prev.panes[paneId]) return state

      // Find the window containing this pane
      const windowId = Object.keys(prev.windows).find((wid) => prev.windows[wid].paneIds.includes(paneId))
      if (!windowId) return state

      const win = prev.windows[windowId]
      const remainingPanes = win.paneIds.filter((p) => p !== paneId)

      // Copy-remove the pane
      const { [paneId]: _removed, ...panes } = prev.panes

      // If this was the last pane in the window, remove the window entirely
      if (remainingPanes.length === 0) {
        const rows = prev.rows
          .map((r) => ({ ...r, windowIds: r.windowIds.filter((w) => w !== windowId) }))
          .filter((r) => r.windowIds.length > 0)
        const { [windowId]: _removedWin, ...windows } = prev.windows

        let activeWindowId = prev.activeWindowId
        if (activeWindowId === windowId) {
          activeWindowId = rows[0]?.windowIds[0] ?? null
        }

        return {
          layouts: {
            ...state.layouts,
            [sessionId]: { rows, windows, panes, activeWindowId },
          },
        }
      }

      // Window survives — update activePaneId if we removed the active one
      const newActive = win.activePaneId === paneId
        ? remainingPanes[Math.max(0, win.paneIds.indexOf(paneId) - 1)]
        : win.activePaneId

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...prev,
            windows: {
              ...prev.windows,
              [windowId]: { ...win, paneIds: remainingPanes, activePaneId: newActive },
            },
            panes,
          },
        },
      }
    })
  },

  setActivePane: (sessionId, paneId) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev) return state

      // Find the window containing this pane
      const windowId = Object.keys(prev.windows).find((wid) => prev.windows[wid].paneIds.includes(paneId))
      if (!windowId) return state

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...prev,
            activeWindowId: windowId,
            windows: {
              ...prev.windows,
              [windowId]: { ...prev.windows[windowId], activePaneId: paneId },
            },
          },
        },
      }
    })
  },

  cyclePane: (sessionId, dir) => {
    const layout = get().getLayout(sessionId)
    if (!layout.activeWindowId) return
    const win = layout.windows[layout.activeWindowId]
    if (!win || win.paneIds.length < 2) return
    const currentIdx = win.paneIds.indexOf(win.activePaneId)
    const nextIdx = dir === 'next'
      ? (currentIdx + 1) % win.paneIds.length
      : (currentIdx - 1 + win.paneIds.length) % win.paneIds.length
    get().setActivePane(sessionId, win.paneIds[nextIdx])
  },

  // ── Metadata ─────────────────────────────────────────────────

  updatePaneLabel: (sessionId, paneId, label) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev || !prev.panes[paneId]) return state
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...prev,
            panes: { ...prev.panes, [paneId]: { ...prev.panes[paneId], label } },
          },
        },
      }
    })
  },

  updatePaneStatus: (sessionId, paneId, status) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev || !prev.panes[paneId]) return state
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...prev,
            panes: { ...prev.panes, [paneId]: { ...prev.panes[paneId], status } },
          },
        },
      }
    })
  },

  markPaneStarted: (sessionId, paneId) => {
    set((state) => {
      const prev = state.layouts[sessionId]
      if (!prev || !prev.panes[paneId]) return state
      const pane = prev.panes[paneId]
      if (!pane.stale) return state
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...prev,
            panes: { ...prev.panes, [paneId]: { ...pane, stale: false } },
          },
        },
      }
    })
  },

  // ── Session lifecycle ────────────────────────────────────────

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  clearSessionLayout: (sessionId) => {
    // Before clearing, we should kill the actual PTYs to prevent orphans
    const paneIds = get().getAllPaneIds(sessionId)
    for (const pid of paneIds) {
      window.api.terminal.kill(pid)
      destroyTerminal(pid)
    }

    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.layouts
      return { layouts: rest }
    })
  },

  // ── Template tracking ────────────────────────────────────────

  getSessionTemplateName: (sessionId) => get().templateNames[sessionId] ?? null,

  setSessionTemplateName: (sessionId, name) => {
    set((state) => {
      const next = { ...state.templateNames }
      if (name == null) delete next[sessionId]
      else next[sessionId] = name
      return { templateNames: next }
    })
  },
}))
