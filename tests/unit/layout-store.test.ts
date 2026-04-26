import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Test the layout store's state transitions.
 * We test the pure logic here — DOM manipulation is tested via e2e.
 */

// Inline the store logic so we can test without zustand's React dependency
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

function setSidebarWidth(state: LayoutState, width: number): LayoutState {
  return { ...state, sidebarWidth: Math.max(140, Math.min(500, width)) }
}

function setTerminalWidth(state: LayoutState, width: number): LayoutState {
  return { ...state, terminalWidth: Math.max(200, Math.min(800, width)) }
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

  it('clamps sidebar width to min/max', () => {
    state = setSidebarWidth(state, 50)
    expect(state.sidebarWidth).toBe(140)
    state = setSidebarWidth(state, 9999)
    expect(state.sidebarWidth).toBe(500)
  })

  it('clamps terminal width to min/max', () => {
    state = setTerminalWidth(state, 50)
    expect(state.terminalWidth).toBe(200)
    state = setTerminalWidth(state, 9999)
    expect(state.terminalWidth).toBe(800)
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
