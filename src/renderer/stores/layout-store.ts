import { create } from 'zustand'

const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 500
const SIDEBAR_DEFAULT = 220
const TERMINAL_MIN = 200
const TERMINAL_MAX = 800
const TERMINAL_DEFAULT = 400

interface LayoutStore {
  sidebarWidth: number
  terminalWidth: number
  sidebarVisible: boolean
  terminalVisible: boolean

  // Side-by-side chat panels. When `dualChat` is true, App renders two
  // ChatPanel instances with `rightSessionId` bound to the right panel.
  // `chatSplitRatio` is the fraction of the combined chat space given to
  // the LEFT panel (0.5 = 50/50).
  dualChat: boolean
  rightSessionId: string | null
  chatSplitRatio: number

  // DOM refs for direct manipulation (not serialized)
  sidebarEl: HTMLDivElement | null
  terminalEl: HTMLDivElement | null

  registerSidebarEl: (el: HTMLDivElement | null) => void
  registerTerminalEl: (el: HTMLDivElement | null) => void

  toggleSidebar: () => void
  toggleTerminal: () => void
  setSidebarWidth: (width: number) => void
  setTerminalWidth: (width: number) => void

  // Dual-chat controls
  openRightPanel: (sessionId: string) => void
  closeRightPanel: () => void
  /**
   * Close the LEFT panel. In practice this swaps the right session into
   * the primary `activeSessionId` slot and exits dual mode. Used when the
   * user clicks the X on the left panel.
   */
  closeLeftPanel: (setActiveSession: (id: string) => void) => void
  toggleDualChat: () => void
  setChatSplitRatio: (ratio: number) => void
}

function applyPanelVisibility(
  el: HTMLDivElement | null,
  visible: boolean,
  width: number,
): void {
  if (!el) return
  el.style.width = visible ? `${width}px` : '0px'
  el.style.visibility = visible ? 'visible' : 'hidden'
  el.style.overflow = visible ? 'visible' : 'hidden'
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  sidebarWidth: SIDEBAR_DEFAULT,
  terminalWidth: TERMINAL_DEFAULT,
  sidebarVisible: true,
  terminalVisible: true,

  dualChat: false,
  rightSessionId: null,
  chatSplitRatio: 0.5,

  sidebarEl: null,
  terminalEl: null,

  registerSidebarEl: (el) => set({ sidebarEl: el }),
  registerTerminalEl: (el) => set({ terminalEl: el }),

  toggleSidebar: () => {
    const { sidebarVisible, sidebarWidth, sidebarEl } = get()
    const next = !sidebarVisible
    applyPanelVisibility(sidebarEl, next, sidebarWidth)
    set({ sidebarVisible: next })
  },

  toggleTerminal: () => {
    const { terminalVisible, terminalWidth, terminalEl } = get()
    const next = !terminalVisible
    applyPanelVisibility(terminalEl, next, terminalWidth)
    set({ terminalVisible: next })
  },

  setSidebarWidth: (width) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width))
    const { sidebarEl } = get()
    if (sidebarEl) sidebarEl.style.width = `${clamped}px`
    set({ sidebarWidth: clamped })
  },

  setTerminalWidth: (width) => {
    const clamped = Math.max(TERMINAL_MIN, Math.min(TERMINAL_MAX, width))
    const { terminalEl } = get()
    if (terminalEl) terminalEl.style.width = `${clamped}px`
    set({ terminalWidth: clamped })
  },

  openRightPanel: (sessionId: string) => {
    set({ dualChat: true, rightSessionId: sessionId })
  },

  closeRightPanel: () => {
    set({ dualChat: false, rightSessionId: null })
  },

  closeLeftPanel: (setActiveSession) => {
    const { rightSessionId } = get()
    if (rightSessionId) {
      // Promote the right session into the primary slot, then exit dual.
      setActiveSession(rightSessionId)
    }
    set({ dualChat: false, rightSessionId: null })
  },

  toggleDualChat: () => {
    const { dualChat } = get()
    if (dualChat) {
      set({ dualChat: false, rightSessionId: null })
    } else {
      // Caller should follow up with openRightPanel(id) to bind a session.
      set({ dualChat: true })
    }
  },

  setChatSplitRatio: (ratio: number) => {
    const clamped = Math.max(0.2, Math.min(0.8, ratio))
    set({ chatSplitRatio: clamped })
  },
}))
