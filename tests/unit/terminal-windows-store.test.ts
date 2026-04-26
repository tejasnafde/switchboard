import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore } from '../../src/renderer/stores/terminal-store'

/**
 * New model: Session → Rows → Windows (columns) → Panes (tabs).
 * A "window" is a spatial slot (like tmux pane). Each window holds a stack of
 * panes (tabs) that share the same screen area.
 */

function resetStore() {
  useTerminalStore.setState({
    layouts: {},
    globalActivePaneId: null,
    activeSessionId: null,
  })
}

describe('terminal window/pane store', () => {
  beforeEach(resetStore)

  const SID = 'session_1'

  // ── Empty state ──────────────────────────────────────────────

  it('starts with empty layout', () => {
    const layout = useTerminalStore.getState().getLayout(SID)
    expect(layout.rows).toEqual([])
    expect(layout.windows).toEqual({})
    expect(layout.panes).toEqual({})
    expect(layout.activeWindowId).toBeNull()
  })

  // ── addWindow (creates a new window with an initial pane) ────

  it('addWindow creates a row with one window and one pane', () => {
    const { addWindow, getLayout } = useTerminalStore.getState()
    const { windowId, paneId } = addWindow(SID, { label: 'W1' })

    const layout = getLayout(SID)
    expect(layout.rows).toHaveLength(1)
    expect(layout.rows[0].windowIds).toEqual([windowId])
    expect(layout.windows[windowId].paneIds).toEqual([paneId])
    expect(layout.windows[windowId].activePaneId).toBe(paneId)
    expect(layout.activeWindowId).toBe(windowId)
    expect(layout.panes[paneId].label).toBe('W1')
  })

  // ── splitActiveWindow ────────────────────────────────────────

  it('splitActiveWindow(row) adds window to same row (right)', () => {
    const { addWindow, splitActiveWindow, getLayout } = useTerminalStore.getState()
    const first = addWindow(SID, { label: 'W1' })
    const second = splitActiveWindow(SID, 'row', { label: 'W2' })

    const layout = getLayout(SID)
    expect(layout.rows).toHaveLength(1) // still one row
    expect(layout.rows[0].windowIds).toEqual([first.windowId, second!.windowId])
    expect(layout.activeWindowId).toBe(second!.windowId)
  })

  it('splitActiveWindow(column) adds window to new row below', () => {
    const { addWindow, splitActiveWindow, getLayout } = useTerminalStore.getState()
    addWindow(SID, { label: 'W1' })
    const split = splitActiveWindow(SID, 'column', { label: 'W2' })

    const layout = getLayout(SID)
    expect(layout.rows).toHaveLength(2) // new row
    expect(layout.rows[1].windowIds).toEqual([split!.windowId])
  })

  // ── addPaneToActiveWindow (stacking/tabs) ────────────────────

  it('addPaneToActiveWindow stacks a new pane in the active window', () => {
    const { addWindow, addPaneToActiveWindow, getLayout } = useTerminalStore.getState()
    const first = addWindow(SID, { label: 'W1' })
    const tab2 = addPaneToActiveWindow(SID, { label: 'tab2' })

    const layout = getLayout(SID)
    expect(layout.rows).toHaveLength(1)
    expect(layout.windows[first.windowId].paneIds).toEqual([first.paneId, tab2])
    expect(layout.windows[first.windowId].activePaneId).toBe(tab2)
    expect(layout.panes[tab2].label).toBe('tab2')
  })

  // ── cyclePane (next/prev within active window) ───────────────

  it('cyclePane(next) moves active pane forward, wrapping', () => {
    const { addWindow, addPaneToActiveWindow, cyclePane, getLayout } = useTerminalStore.getState()
    const { windowId, paneId: p1 } = addWindow(SID, { label: 'A' })
    const p2 = addPaneToActiveWindow(SID, { label: 'B' })
    const p3 = addPaneToActiveWindow(SID, { label: 'C' })

    // currently active is p3
    cyclePane(SID, 'next')
    expect(getLayout(SID).windows[windowId].activePaneId).toBe(p1)
    cyclePane(SID, 'next')
    expect(getLayout(SID).windows[windowId].activePaneId).toBe(p2)
    cyclePane(SID, 'prev')
    expect(getLayout(SID).windows[windowId].activePaneId).toBe(p1)
    cyclePane(SID, 'prev')
    expect(getLayout(SID).windows[windowId].activePaneId).toBe(p3)
  })

  // ── removePaneFromWindow ─────────────────────────────────────

  it('removePane from multi-tab window keeps the window', () => {
    const { addWindow, addPaneToActiveWindow, removePane, getLayout } = useTerminalStore.getState()
    const { windowId, paneId: p1 } = addWindow(SID, { label: 'A' })
    const p2 = addPaneToActiveWindow(SID, { label: 'B' })

    removePane(SID, p1)

    const layout = getLayout(SID)
    expect(layout.rows).toHaveLength(1)
    expect(layout.windows[windowId].paneIds).toEqual([p2])
    expect(layout.windows[windowId].activePaneId).toBe(p2)
    expect(layout.panes[p1]).toBeUndefined()
  })

  it('removePane from single-tab window removes the window too', () => {
    const { addWindow, splitActiveWindow, removePane, getLayout } = useTerminalStore.getState()
    addWindow(SID, { label: 'A' })
    const split = splitActiveWindow(SID, 'row', { label: 'B' })

    removePane(SID, split!.paneId)

    const layout = getLayout(SID)
    expect(layout.rows).toHaveLength(1)
    expect(layout.rows[0].windowIds).toHaveLength(1) // only the first window remains
    expect(layout.windows[split!.windowId]).toBeUndefined()
  })

  it('removeWindow closes all its panes', () => {
    const { addWindow, addPaneToActiveWindow, removeWindow, getLayout } = useTerminalStore.getState()
    const { windowId, paneId: p1 } = addWindow(SID, { label: 'A' })
    const p2 = addPaneToActiveWindow(SID, { label: 'B' })

    removeWindow(SID, windowId)

    const layout = getLayout(SID)
    expect(layout.windows[windowId]).toBeUndefined()
    expect(layout.panes[p1]).toBeUndefined()
    expect(layout.panes[p2]).toBeUndefined()
  })

  // ── setActivePane (within its window) ────────────────────────

  it('setActivePane switches the window focus and tab', () => {
    const { addWindow, addPaneToActiveWindow, setActivePane, getLayout } = useTerminalStore.getState()
    const { windowId, paneId: p1 } = addWindow(SID, { label: 'A' })
    const p2 = addPaneToActiveWindow(SID, { label: 'B' })

    setActivePane(SID, p1)
    const layout = getLayout(SID)
    expect(layout.windows[windowId].activePaneId).toBe(p1)
    expect(layout.activeWindowId).toBe(windowId)

    setActivePane(SID, p2)
    expect(getLayout(SID).windows[windowId].activePaneId).toBe(p2)
  })

  // ── focusWindowByIndex (⌘1..9) ───────────────────────────────

  it('focusWindowByIndex focuses the Nth window (left-to-right, top-to-bottom)', () => {
    const { addWindow, splitActiveWindow, focusWindowByIndex, getLayout } = useTerminalStore.getState()
    const first = addWindow(SID, { label: 'W1' })
    const second = splitActiveWindow(SID, 'row', { label: 'W2' })
    const third = splitActiveWindow(SID, 'column', { label: 'W3' }) // new row

    focusWindowByIndex(SID, 0)
    expect(getLayout(SID).activeWindowId).toBe(first.windowId)
    focusWindowByIndex(SID, 1)
    expect(getLayout(SID).activeWindowId).toBe(second!.windowId)
    focusWindowByIndex(SID, 2)
    expect(getLayout(SID).activeWindowId).toBe(third!.windowId)
  })

  // ── focusDirection (⌘⌥+Arrow) ────────────────────────────────

  it('focusDirection navigates between windows', () => {
    const { addWindow, splitActiveWindow, focusDirection, getLayout } = useTerminalStore.getState()
    const w1 = addWindow(SID, { label: 'W1' })
    const w2 = splitActiveWindow(SID, 'row', { label: 'W2' }) // w2 is right of w1

    focusDirection(SID, 'left')
    expect(getLayout(SID).activeWindowId).toBe(w1.windowId)

    focusDirection(SID, 'right')
    expect(getLayout(SID).activeWindowId).toBe(w2!.windowId)
  })

  // ── getAllPaneIds + getAllWindowIds ──────────────────────────

  it('getAllWindowIds returns windows in row-major order', () => {
    const { addWindow, splitActiveWindow, getAllWindowIds } = useTerminalStore.getState()
    const w1 = addWindow(SID, { label: 'W1' })
    const w2 = splitActiveWindow(SID, 'row', { label: 'W2' })
    const w3 = splitActiveWindow(SID, 'column', { label: 'W3' })

    const ids = getAllWindowIds(SID)
    expect(ids).toEqual([w1.windowId, w2!.windowId, w3!.windowId])
  })

  it('getAllPaneIds returns all panes across all windows', () => {
    const { addWindow, addPaneToActiveWindow, splitActiveWindow, getAllPaneIds } = useTerminalStore.getState()
    const w1 = addWindow(SID, { label: 'A' })
    const p1b = addPaneToActiveWindow(SID, { label: 'A2' })
    const w2 = splitActiveWindow(SID, 'row', { label: 'B' })

    const ids = getAllPaneIds(SID)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(w1.paneId)
    expect(ids).toContain(p1b)
    expect(ids).toContain(w2!.paneId)
  })

  // ── session isolation ───────────────────────────────────────

  it('different sessions have independent layouts', () => {
    const { addWindow, getLayout } = useTerminalStore.getState()
    addWindow('sA', { label: 'A' })
    addWindow('sB', { label: 'B' })
    addWindow('sB', { label: 'B2' })

    expect(Object.keys(getLayout('sA').windows)).toHaveLength(1)
    expect(Object.keys(getLayout('sB').windows)).toHaveLength(2)
  })
})
