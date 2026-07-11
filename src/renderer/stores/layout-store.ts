import { create } from 'zustand'
import { createRendererLogger } from '../logger'
import { useAgentStore } from './agent-store'

const log = createRendererLogger('store:layout')

const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 500
const SIDEBAR_DEFAULT = 220
const TERMINAL_MIN = 200
const TERMINAL_MAX = 800
const TERMINAL_DEFAULT = 400

export type RightPaneMode = 'terminal' | 'files'

/**
 * Top-level app view. `'chats'` is the default - sidebar + chat pane +
 * right column (terminal/files). `'kanban'` swaps the chat+right area
 * for a workspace-scoped board; the sidebar stays mounted so workspace
 * + project clicks drive the board's filter (and clicking a session
 * exits back to chats). ⌘⇧K toggles. Persisted via settings DB.
 */
export type AppView = 'chats' | 'kanban'

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

  /**
   * Top-level app view ('chats' | 'kanban'). Toggle with ⌘⇧K.
   * `kanbanWorkspaceFilter` scopes the board to one workspace id, or null
   * for "All workspaces" / unassigned. `kanbanProjectFilter` further
   * narrows to a single project path; null = every project in scope.
   */
  appView: AppView
  setAppView: (v: AppView) => void
  toggleAppView: () => void
  kanbanWorkspaceFilter: string | null
  kanbanProjectFilter: string | null
  setKanbanWorkspaceFilter: (id: string | null) => void
  setKanbanProjectFilter: (path: string | null) => void

  /** Open a file in the embedded IDE workbench, flipping the right pane to it. */
  openInViewer: (
    path: string,
    lineRange?: { start: number; end: number } | null,
  ) => void

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

// Persistence keys for sidebar collapse state - kept tight so we don't
// accidentally collide with the existing `projectOrder` / `theme` keys.
const COLLAPSE_PROJECTS_KEY = 'sidebar.collapsed.projects'
const COLLAPSE_WORKSPACES_KEY = 'sidebar.collapsed.workspaces'
const RIGHT_PANE_MODE_KEY = 'layout.rightPaneMode'
const APP_VIEW_KEY = 'layout.appView'
const KANBAN_WS_FILTER_KEY = 'layout.kanbanWorkspaceFilter'
const KANBAN_PROJECT_FILTER_KEY = 'layout.kanbanProjectFilter'

function persistList(key: string, list: string[]): void {
  try {
    void window.api?.settings?.set(key, JSON.stringify(list))
  } catch { /* settings unavailable in tests / early boot */ }
}

// Panel width + visibility are driven from JSX in App.tsx - do NOT
// imperatively mutate `el.style.*` here on toggle. React's style
// reconciler skips writes when the JSX string is unchanged, so a
// hybrid imperative/JSX approach left DOM diverged from state after a
// hide/show cycle and broke both ResizeHandle drag handles. Pinned by
// tests/unit/resize-handle-wiring.test.ts.

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
    // 2-mode cycle: terminal ↔ files. (Kanban is now a top-level view -
    // see appView/⌘⇧K - not a right-pane mode.)
    const cur = get().rightPaneMode
    const next: RightPaneMode = cur === 'terminal' ? 'files' : 'terminal'
    try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, next) } catch { /* ignore */ }
    set({ rightPaneMode: next })
  },

  appView: 'chats',
  setAppView: (v) => {
    try { void window.api?.settings?.set(APP_VIEW_KEY, v) } catch { /* ignore */ }
    set({ appView: v })
  },
  toggleAppView: () => {
    const next: AppView = get().appView === 'chats' ? 'kanban' : 'chats'
    try { void window.api?.settings?.set(APP_VIEW_KEY, next) } catch { /* ignore */ }
    set({ appView: next })
  },
  kanbanWorkspaceFilter: null,
  kanbanProjectFilter: null,
  setKanbanWorkspaceFilter: (id) => {
    try { void window.api?.settings?.set(KANBAN_WS_FILTER_KEY, id ?? '') } catch { /* ignore */ }
    // Clearing workspace also clears project filter - a project belongs
    // to one workspace, so a stale project filter under a new workspace
    // would silently render zero cards.
    set({ kanbanWorkspaceFilter: id, kanbanProjectFilter: null })
  },
  setKanbanProjectFilter: (path) => {
    try { void window.api?.settings?.set(KANBAN_PROJECT_FILTER_KEY, path ?? '') } catch { /* ignore */ }
    set({ kanbanProjectFilter: path })
  },

  openInViewer: (path, lineRange = null) => {
    // Flip the right pane to the IDE, then route the open to the workbench
    // serving the active session's repo. Fire-and-forget: if the ext host
    // isn't connected yet (workbench still booting), the click simply
    // focuses the pane.
    set({ rightPaneMode: 'files' })
    try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, 'files') } catch { /* ignore */ }
    try {
      const agent = useAgentStore.getState()
      const session = agent.sessions.find((x) => x.id === agent.activeSessionId)
      const folder = session?.worktreePath ?? session?.projectPath
      if (folder) {
        void window.api?.ide?.open({
          folder,
          path,
          line: lineRange?.start,
          endLine: lineRange?.end,
        })
      }
    } catch (err) {
      log.warn('openInViewer routing failed', err)
    }
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
    set({ sidebarVisible: !get().sidebarVisible })
  },

  toggleTerminal: () => {
    set({ terminalVisible: !get().terminalVisible })
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
 * (App.tsx). Failures are silent - the store keeps its empty defaults.
 */
export async function hydrateSidebarCollapse(): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.settings) return
  try {
    const [projJson, wsJson, modeStr, appViewStr, kanbanWsStr, kanbanProjStr] = await Promise.all([
      window.api.settings.get(COLLAPSE_PROJECTS_KEY),
      window.api.settings.get(COLLAPSE_WORKSPACES_KEY),
      window.api.settings.get(RIGHT_PANE_MODE_KEY),
      window.api.settings.get(APP_VIEW_KEY),
      window.api.settings.get(KANBAN_WS_FILTER_KEY),
      window.api.settings.get(KANBAN_PROJECT_FILTER_KEY),
    ])
    const parse = (s: string | null): string[] => {
      if (!s) return []
      try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] }
      catch { return [] }
    }
    const mode: RightPaneMode = modeStr === 'files' ? 'files' : 'terminal'
    const appView: AppView = appViewStr === 'kanban' ? 'kanban' : 'chats'
    useLayoutStore.setState({
      sidebarCollapsedProjects: parse(projJson),
      sidebarCollapsedWorkspaces: parse(wsJson),
      rightPaneMode: mode,
      appView,
      kanbanWorkspaceFilter: kanbanWsStr || null,
      kanbanProjectFilter: kanbanProjStr || null,
    })
  } catch { /* silent */ }
}
