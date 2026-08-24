import { create } from 'zustand'
import { createRendererLogger } from '../logger'
import { useAgentStore } from './agent-store'
import {
  companionSessionId,
  displayedChatSessionIds,
  focusedChatSessionId,
  reconcileChatWorkspace,
  sessionForSlot,
  slotForSession,
  type ChatSlot,
  type ChatWorkspaceEvent,
  type ChatWorkspaceState,
} from '../services/chatWorkspace'
import {
  publishChatWorkspace,
  registerChatWorkspaceController,
} from '../services/chatWorkspaceRuntime'

const log = createRendererLogger('store:layout')

const SIDEBAR_MIN = 140
const SIDEBAR_DEFAULT = 220
const TERMINAL_MIN = 200
const TERMINAL_DEFAULT = 400

/**
 * Minimum breathing room (px) the center chat area keeps. There is no fixed
 * upper bound on a pane's width anymore - you can stretch either pane as far
 * as you like (⌘B / ⌘J hide them entirely) - but a pane can't grow so wide
 * that it would push the chat (and the opposite pane's own resize handle) off
 * screen. The cap is therefore relative to the viewport and the other pane's
 * current width rather than a hard-coded number.
 */
const MIN_CHAT_WIDTH = 240

/** Largest width a pane may take: viewport minus the other pane and the chat's
 *  minimum. Falls back to a huge value when `window` is unavailable (tests). */
export function paneMaxWidth(min: number, otherPaneWidth: number, viewportWidth?: number): number {
  const vw = viewportWidth ?? (typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : Number.MAX_SAFE_INTEGER)
  return Math.max(min, vw - otherPaneWidth - MIN_CHAT_WIDTH)
}

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
  /** Data scientist mode (⌘⇧J): workbench takes the wide center slot, chat
   *  docks right. CSS order/size swap only - every pane stays mounted. */
  dataScienceMode: boolean
  toggleDataScienceMode: () => void

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
    sessionId?: string | null,
  ) => void

  // `chatSplitRatio` is the fraction of the combined chat space given to
  // the primary panel (0.5 = 50/50).
  chatSplitRatio: number
  primarySessionId: string | null
  secondarySessionId: string | null
  focusedChatSlot: ChatSlot
  selectChatSession: (sessionId: string) => void
  openChatBeside: (sessionId: string) => void
  focusChatSlot: (slot: ChatSlot) => void
  closeChatSlot: (slot: ChatSlot) => void
  reconcileChatSessions: (availableSessionIds: readonly string[]) => void
  rotateChatSessionId: (fromSessionId: string, toSessionId: string) => void
  forwardToChat: (sourceSessionId: string, targetSessionId: string) => void
  focusedChatSessionId: () => string | null
  displayedChatSessionIds: () => string[]
  sessionForChatSlot: (slot: ChatSlot) => string | null
  slotForChatSession: (sessionId: string) => ChatSlot | null
  companionSessionId: () => string | null

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

  setChatSplitRatio: (ratio: number) => void
}

// Persistence keys for sidebar collapse state - kept tight so we don't
// accidentally collide with existing theme and provider preference keys.
const COLLAPSE_PROJECTS_KEY = 'sidebar.collapsed.projects'
const COLLAPSE_WORKSPACES_KEY = 'sidebar.collapsed.workspaces'
const RIGHT_PANE_MODE_KEY = 'layout.rightPaneMode'
const APP_VIEW_KEY = 'layout.appView'
const DATA_SCIENCE_MODE_KEY = 'layout.dataScienceMode'
const KANBAN_WS_FILTER_KEY = 'layout.kanbanWorkspaceFilter'
const KANBAN_PROJECT_FILTER_KEY = 'layout.kanbanProjectFilter'

function currentChatWorkspace(): ChatWorkspaceState {
  const state = useLayoutStore.getState()
  return {
    primarySessionId: state.primarySessionId,
    secondarySessionId: state.secondarySessionId,
    focusedSlot: state.focusedChatSlot,
    splitRatio: state.chatSplitRatio,
  }
}

function canonicalSessionId(sessionId: string): string {
  const session = useAgentStore.getState().sessions.find((candidate) => candidate.id === sessionId)
  return session?.conversationId ?? sessionId
}

function applyChatWorkspaceEvent(event: ChatWorkspaceEvent): void {
  const next = reconcileChatWorkspace(currentChatWorkspace(), event, canonicalSessionId)
  publishChatWorkspace(next)
  useLayoutStore.setState({
    primarySessionId: next.primarySessionId,
    secondarySessionId: next.secondarySessionId,
    focusedChatSlot: next.focusedSlot,
    chatSplitRatio: next.splitRatio,
  })
  useAgentStore.setState((state) => ({
    activeSessionId: next.primarySessionId,
    sessions: state.sessions.map((session) =>
      session.id === next.primarySessionId && session.unreadCount !== 0
        ? { ...session, unreadCount: 0 }
        : session
    ),
  }))
}

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

  chatSplitRatio: 0.5,
  primarySessionId: null,
  secondarySessionId: null,
  focusedChatSlot: 'primary',
  selectChatSession: (sessionId) => applyChatWorkspaceEvent({ type: 'select', sessionId }),
  openChatBeside: (sessionId) => applyChatWorkspaceEvent({ type: 'open-beside', sessionId }),
  focusChatSlot: (slot) => applyChatWorkspaceEvent({ type: 'focus', slot }),
  closeChatSlot: (slot) => applyChatWorkspaceEvent({ type: 'close', slot }),
  reconcileChatSessions: (availableSessionIds) => applyChatWorkspaceEvent({ type: 'restore', availableSessionIds }),
  rotateChatSessionId: (fromSessionId, toSessionId) => applyChatWorkspaceEvent({ type: 'rotate', fromSessionId, toSessionId }),
  forwardToChat: (sourceSessionId, targetSessionId) => applyChatWorkspaceEvent({ type: 'forward-target', sourceSessionId, targetSessionId }),
  focusedChatSessionId: () => focusedChatSessionId(currentChatWorkspace()),
  displayedChatSessionIds: () => displayedChatSessionIds(currentChatWorkspace()),
  sessionForChatSlot: (slot) => sessionForSlot(currentChatWorkspace(), slot),
  slotForChatSession: (sessionId) => slotForSession(currentChatWorkspace(), sessionId, canonicalSessionId),
  companionSessionId: () => companionSessionId(currentChatWorkspace()),

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

  dataScienceMode: false,
  toggleDataScienceMode: () => {
    const next = !get().dataScienceMode
    try { void window.api?.settings?.set(DATA_SCIENCE_MODE_KEY, String(next)) } catch { /* ignore */ }
    // Entering DS mode surfaces the workbench in the wide slot; leaving it
    // keeps whatever right-pane mode the user last had.
    if (next) {
      try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, 'files') } catch { /* ignore */ }
      set({ dataScienceMode: true, rightPaneMode: 'files' })
    } else {
      set({ dataScienceMode: false })
    }
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

  openInViewer: (path, lineRange = null, sessionId = null) => {
    // Flip the right pane to the IDE, then route the open to the workbench
    // serving the active session's repo. Fire-and-forget: if the ext host
    // isn't connected yet (workbench still booting), the click simply
    // focuses the pane.
    set({ rightPaneMode: 'files' })
    try { void window.api?.settings?.set(RIGHT_PANE_MODE_KEY, 'files') } catch { /* ignore */ }
    try {
      const agent = useAgentStore.getState()
      const targetSessionId = sessionId ?? useLayoutStore.getState().companionSessionId()
      const session = agent.sessions.find((x) => x.id === targetSessionId)
      const folder = session?.worktreePath ?? session?.projectPath
      if (folder) {
        // A remote session's workbench (and the file) live on that machine;
        // `folder` is not a routing key, so name the backend explicitly.
        // The invoke rejects if that machine went offline between the click and
        // here, which the surrounding try cannot catch.
        window.api?.ide
          ?.open({ folder, path, line: lineRange?.start, endLine: lineRange?.end, machineId: session?.machineId })
          .catch((err) => log.warn('openInViewer open failed', err))
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
    const { sidebarEl, terminalVisible, terminalWidth } = get()
    const max = paneMaxWidth(SIDEBAR_MIN, terminalVisible ? terminalWidth : 0)
    const clamped = Math.max(SIDEBAR_MIN, Math.min(max, width))
    if (sidebarEl) sidebarEl.style.width = `${clamped}px`
    set({ sidebarWidth: clamped })
  },

  setTerminalWidth: (width) => {
    const { terminalEl, sidebarVisible, sidebarWidth } = get()
    const max = paneMaxWidth(TERMINAL_MIN, sidebarVisible ? sidebarWidth : 0)
    const clamped = Math.max(TERMINAL_MIN, Math.min(max, width))
    if (terminalEl) terminalEl.style.width = `${clamped}px`
    set({ terminalWidth: clamped })
  },

  setChatSplitRatio: (ratio: number) => {
    applyChatWorkspaceEvent({ type: 'set-split-ratio', ratio })
  },
}))

registerChatWorkspaceController({
  selectSession: (sessionId) => applyChatWorkspaceEvent({ type: 'select', sessionId }),
  removeSession: (sessionId) => applyChatWorkspaceEvent({ type: 'remove', sessionId }),
  rotateSession: (fromSessionId, toSessionId) =>
    applyChatWorkspaceEvent({ type: 'rotate', fromSessionId, toSessionId }),
})

/**
 * Hydrate sidebar collapse state from settings DB. Called once at app boot
 * (App.tsx). Failures are silent - the store keeps its empty defaults.
 */
export async function hydrateSidebarCollapse(): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.settings) return
  try {
    const [projJson, wsJson, modeStr, appViewStr, kanbanWsStr, kanbanProjStr, dsModeStr] = await Promise.all([
      window.api.settings.get(COLLAPSE_PROJECTS_KEY),
      window.api.settings.get(COLLAPSE_WORKSPACES_KEY),
      window.api.settings.get(RIGHT_PANE_MODE_KEY),
      window.api.settings.get(APP_VIEW_KEY),
      window.api.settings.get(KANBAN_WS_FILTER_KEY),
      window.api.settings.get(KANBAN_PROJECT_FILTER_KEY),
      window.api.settings.get(DATA_SCIENCE_MODE_KEY),
    ])
    const parse = (s: string | null): string[] => {
      if (!s) return []
      try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] }
      catch { return [] }
    }
    const mode: RightPaneMode = modeStr === 'files' ? 'files' : 'terminal'
    const appView: AppView = appViewStr === 'kanban' ? 'kanban' : 'chats'
    const dataScienceMode = dsModeStr === 'true'
    useLayoutStore.setState({
      sidebarCollapsedProjects: parse(projJson),
      sidebarCollapsedWorkspaces: parse(wsJson),
      // DS mode needs the workbench in the wide slot regardless of the
      // persisted right-pane mode.
      rightPaneMode: dataScienceMode ? 'files' : mode,
      appView,
      kanbanWorkspaceFilter: kanbanWsStr || null,
      kanbanProjectFilter: kanbanProjStr || null,
      dataScienceMode,
    })
  } catch { /* silent */ }
}
