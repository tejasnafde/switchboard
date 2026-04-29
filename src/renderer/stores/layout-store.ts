import { create } from 'zustand'

const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 500
const SIDEBAR_DEFAULT = 220
const TERMINAL_MIN = 200
const TERMINAL_MAX = 800
const TERMINAL_DEFAULT = 400

export type RightPaneMode = 'terminal' | 'files'

interface LayoutStore {
  sidebarWidth: number
  terminalWidth: number
  sidebarVisible: boolean
  terminalVisible: boolean

  /**
   * What the right-pane container shows. `'terminal'` = the existing
   * tmux-style window/pane strip. `'files'` = the file tree + viewer
   * (Cursor-glass-inspired). ⌘⇧E toggles. Persisted via settings DB.
   */
  rightPaneMode: RightPaneMode
  setRightPaneMode: (mode: RightPaneMode) => void
  toggleRightPaneMode: () => void

  /** Active file path open in the viewer (repo-relative). */
  viewerFilePath: string | null
  /** Optional line range to scroll/highlight in the viewer. */
  viewerLineRange: { start: number; end: number } | null
  openInViewer: (path: string, lineRange?: { start: number; end: number } | null) => void

  // Side-by-side chat panels. When `dualChat` is true, App renders two
  // ChatPanel instances with `rightSessionId` bound to the right panel.
  // `chatSplitRatio` is the fraction of the combined chat space given to
  // the LEFT panel (0.5 = 50/50).
  dualChat: boolean
  rightSessionId: string | null
  chatSplitRatio: number

  // ─── Persisted sidebar collapse state ────────────────────────
  // String[] (not Set) because settings are JSON-serialized via
  // window.api.settings. A project path is collapsed iff it's in the
  // array; same for workspace ids. Hydrated on store creation.
  sidebarCollapsedProjects: string[]
  sidebarCollapsedWorkspaces: string[]
  toggleSidebarProject: (path: string) => void
  toggleSidebarWorkspace: (id: string) => void
  setSidebarCollapsedProjects: (paths: string[]) => void
  expandSidebarProject: (path: string) => void
  expandSidebarWorkspace: (id: string) => void

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

// Persistence keys for sidebar collapse state — kept tight so we don't
// accidentally collide with the existing `projectOrder` / `theme` keys.
const COLLAPSE_PROJECTS_KEY = 'sidebar.collapsed.projects'
const COLLAPSE_WORKSPACES_KEY = 'sidebar.collapsed.workspaces'
const RIGHT_PANE_MODE_KEY = 'layout.rightPaneMode'

function persistList(key: string, list: string[]): void {
  try {
    void window.api?.settings?.set(key, JSON.stringify(list))
  } catch { /* settings unavailable in tests / early boot */ }
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

  rightPaneMode: 'terminal',
  setRightPaneMode: (mode) => {
    try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, mode) } catch { /* ignore */ }
    set({ rightPaneMode: mode })
  },
  toggleRightPaneMode: () => {
    const next: RightPaneMode = get().rightPaneMode === 'terminal' ? 'files' : 'terminal'
    try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, next) } catch { /* ignore */ }
    set({ rightPaneMode: next })
  },

  viewerFilePath: null,
  viewerLineRange: null,
  openInViewer: (path, lineRange = null) => {
    set({
      viewerFilePath: path,
      viewerLineRange: lineRange,
      rightPaneMode: 'files',
    })
    try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, 'files') } catch { /* ignore */ }
  },

  sidebarCollapsedProjects: [],
  sidebarCollapsedWorkspaces: [],

  toggleSidebarProject: (path) => {
    const cur = get().sidebarCollapsedProjects
    const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
    persistList(COLLAPSE_PROJECTS_KEY, next)
    set({ sidebarCollapsedProjects: next })
  },
  toggleSidebarWorkspace: (id) => {
    const cur = get().sidebarCollapsedWorkspaces
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    persistList(COLLAPSE_WORKSPACES_KEY, next)
    set({ sidebarCollapsedWorkspaces: next })
  },
  setSidebarCollapsedProjects: (paths) => {
    persistList(COLLAPSE_PROJECTS_KEY, paths)
    set({ sidebarCollapsedProjects: paths })
  },
  expandSidebarProject: (path) => {
    const cur = get().sidebarCollapsedProjects
    if (!cur.includes(path)) return
    const next = cur.filter((p) => p !== path)
    persistList(COLLAPSE_PROJECTS_KEY, next)
    set({ sidebarCollapsedProjects: next })
  },
  expandSidebarWorkspace: (id) => {
    const cur = get().sidebarCollapsedWorkspaces
    if (!cur.includes(id)) return
    const next = cur.filter((x) => x !== id)
    persistList(COLLAPSE_WORKSPACES_KEY, next)
    set({ sidebarCollapsedWorkspaces: next })
  },

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

/**
 * Hydrate sidebar collapse state from settings DB. Called once at app boot
 * (App.tsx). Failures are silent — the store keeps its empty defaults.
 */
export async function hydrateSidebarCollapse(): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.settings) return
  try {
    const [projJson, wsJson, modeStr] = await Promise.all([
      window.api.settings.get(COLLAPSE_PROJECTS_KEY),
      window.api.settings.get(COLLAPSE_WORKSPACES_KEY),
      window.api.settings.get(RIGHT_PANE_MODE_KEY),
    ])
    const parse = (s: string | null): string[] => {
      if (!s) return []
      try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] }
      catch { return [] }
    }
    const mode: RightPaneMode = modeStr === 'files' ? 'files' : 'terminal'
    useLayoutStore.setState({
      sidebarCollapsedProjects: parse(projJson),
      sidebarCollapsedWorkspaces: parse(wsJson),
      rightPaneMode: mode,
    })
  } catch { /* silent */ }
}

/**
 * Standalone hydration for the right-pane mode setting. Split out so tests
 * (and any caller that only needs this slice) don't have to stub the whole
 * collapse-state surface. Defaults to `'terminal'` on missing/unrecognized
 * values so users upgrading from a previous build keep their existing UI.
 */
export async function hydrateRightPaneMode(): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.settings) return
  try {
    const v = await window.api.settings.get(RIGHT_PANE_MODE_KEY)
    const mode: RightPaneMode = v === 'files' ? 'files' : 'terminal'
    useLayoutStore.setState({ rightPaneMode: mode })
  } catch { /* silent */ }
}
