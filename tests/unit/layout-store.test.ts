import { describe, it, expect, beforeEach } from 'vitest'
import { paneMaxWidth, useLayoutStore } from '../../src/renderer/stores/layout-store'

/**
 * Test the layout store's state transitions.
 * We mirror the state shape here (no zustand/React dep) but wire the width
 * clamp to the REAL `paneMaxWidth` so the max-width behavior is exercised
 * against production code. DOM manipulation is tested via e2e.
 */

interface LayoutState {
  sidebarWidth: number
  terminalWidth: number
  sidebarVisible: boolean
  terminalVisible: boolean
}

function createLayoutState(overrides?: Partial<LayoutState>): LayoutState {
  return {
    sidebarWidth: 220,
    terminalWidth: 400,
    sidebarVisible: true,
    terminalVisible: true,
    ...overrides,
  }
}

function toggleSidebar(state: LayoutState): LayoutState {
  return { ...state, sidebarVisible: !state.sidebarVisible }
}

function toggleTerminal(state: LayoutState): LayoutState {
  return { ...state, terminalVisible: !state.terminalVisible }
}

// Mirror of the real store setters: min floor + viewport-relative max (no
// fixed cap). Viewport width is passed explicitly (the test env is `node`,
// so there's no real `window`); the real store reads `window.innerWidth`.
function setSidebarWidth(state: LayoutState, width: number, vw = 1600): LayoutState {
  const max = paneMaxWidth(140, state.terminalVisible ? state.terminalWidth : 0, vw)
  return { ...state, sidebarWidth: Math.max(140, Math.min(max, width)) }
}

function setTerminalWidth(state: LayoutState, width: number, vw = 1600): LayoutState {
  const max = paneMaxWidth(200, state.sidebarVisible ? state.sidebarWidth : 0, vw)
  return { ...state, terminalWidth: Math.max(200, Math.min(max, width)) }
}

describe('layout store state transitions', () => {
  let state: LayoutState

  beforeEach(() => {
    state = createLayoutState()
  })

  it('initializes with default widths', () => {
    expect(state.sidebarWidth).toBe(220)
    expect(state.terminalWidth).toBe(400)
    expect(state.sidebarVisible).toBe(true)
    expect(state.terminalVisible).toBe(true)
  })

  it('toggles sidebar visibility', () => {
    state = toggleSidebar(state)
    expect(state.sidebarVisible).toBe(false)
    state = toggleSidebar(state)
    expect(state.sidebarVisible).toBe(true)
  })

  it('toggles terminal visibility', () => {
    state = toggleTerminal(state)
    expect(state.terminalVisible).toBe(false)
  })

  it('preserves sidebar width when toggling', () => {
    state = setSidebarWidth(state, 300)
    state = toggleSidebar(state) // hide
    expect(state.sidebarWidth).toBe(300) // width preserved
    state = toggleSidebar(state) // show
    expect(state.sidebarWidth).toBe(300) // restored
  })

  it('preserves terminal width when toggling', () => {
    state = setTerminalWidth(state, 500)
    state = toggleTerminal(state)
    expect(state.terminalWidth).toBe(500)
  })

  it('clamps sidebar/terminal widths up to the min floor', () => {
    state = setSidebarWidth(state, 50)
    expect(state.sidebarWidth).toBe(140)
    state = setTerminalWidth(state, 50)
    expect(state.terminalWidth).toBe(200)
  })

  it('has no fixed max: a wide viewport allows widths well past the old 500/800 caps', () => {
    // Old caps were 500 (sidebar) / 800 (terminal). Both should now be allowed.
    // Use independent fresh states - widening one pane legitimately shrinks the
    // other's cap (they share the viewport), which is covered separately below.
    const sideState = setSidebarWidth(createLayoutState(), 1200, 2400)
    expect(sideState.sidebarWidth).toBe(1200)
    const termState = setTerminalWidth(createLayoutState(), 1500, 2400)
    expect(termState.terminalWidth).toBe(1500)
  })

  it('caps a pane so the chat + the opposite pane stay on screen', () => {
    // viewport 1000, terminal visible at 400, chat min 240 → sidebar max 360.
    state = createLayoutState({ terminalWidth: 400 })
    state = setSidebarWidth(state, 5000, 1000)
    expect(state.sidebarWidth).toBe(1000 - 400 - 240)
  })

  it('a hidden opposite pane frees up its width for the max', () => {
    // terminal hidden → its 400px no longer subtracted; sidebar max = 1000 - 240.
    state = createLayoutState({ terminalWidth: 400, terminalVisible: false })
    state = setSidebarWidth(state, 5000, 1000)
    expect(state.sidebarWidth).toBe(1000 - 240)
  })

  it('paneMaxWidth falls back to a huge cap when no viewport is available', () => {
    // In the real renderer `window.innerWidth` supplies the bound; with neither
    // an arg nor a window (node test), it must not clamp to something tiny.
    expect(paneMaxWidth(140, 400)).toBeGreaterThan(100000)
  })

  it('sidebar and terminal toggle independently', () => {
    state = toggleSidebar(state)
    expect(state.sidebarVisible).toBe(false)
    expect(state.terminalVisible).toBe(true)
    state = toggleTerminal(state)
    expect(state.sidebarVisible).toBe(false)
    expect(state.terminalVisible).toBe(false)
  })
})

describe('data scientist mode', () => {
  it('toggling on forces the workbench into the wide slot (rightPaneMode files)', () => {
    useLayoutStore.setState({ dataScienceMode: false, rightPaneMode: 'terminal' })
    useLayoutStore.getState().toggleDataScienceMode()
    expect(useLayoutStore.getState().dataScienceMode).toBe(true)
    expect(useLayoutStore.getState().rightPaneMode).toBe('files')
  })

  it('toggling off keeps the current right-pane mode', () => {
    useLayoutStore.setState({ dataScienceMode: true, rightPaneMode: 'files' })
    useLayoutStore.getState().toggleDataScienceMode()
    expect(useLayoutStore.getState().dataScienceMode).toBe(false)
    expect(useLayoutStore.getState().rightPaneMode).toBe('files')
  })
})
