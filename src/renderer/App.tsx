import { useEffect, useRef, useCallback, useState } from 'react'
import { useLayoutStore, hydrateSidebarCollapse, paneMaxWidth } from './stores/layout-store'
import { showDragOverlay, hideDragOverlay } from './services/dragOverlay'
import { useAgentStore, setStoreDefaultRuntimeMode, type RuntimeMode } from './stores/agent-store'
import { classifyCloseFocus, type ClosestEl } from './closeFocus'
import { useBookmarkStore } from './stores/bookmark-store'
import { useThemeStore } from './stores/theme-store'
import { useTerminalStore } from './stores/terminal-store'
import { useMachineStore } from './stores/machine-store'
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle'
import { ResizeHandle } from './components/layout/ResizeHandle'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatPanel } from './components/chat/ChatPanel'
import { TerminalSessionPane } from './components/terminal/TerminalSessionPane'
import { TerminalStrip } from './components/terminal/TerminalStrip'
import { IdePane } from './components/ide/IdePane'
import { KanbanView } from './components/kanban/KanbanView'
import { SettingsModal } from './components/SettingsModal'
import { CommandPalette } from './components/CommandPalette'
import { SearchModal } from './components/SearchModal'
import { StatusBar } from './components/StatusBar'
import { SessionPickerModal } from './components/SessionPickerModal'
import { QuickPromptModal } from './components/QuickPromptModal'
import { FeatureTourModal } from './components/onboarding/FeatureTourModal'
import { UpdateToast } from './components/UpdateToast'
import { NewChatCheckoutDialog, type NewChatCheckout } from './components/NewChatCheckoutDialog'
import { TOUR_VERSION, type TryItAction } from './components/onboarding/featureRegistry'
import { appendIdeSelectionToDraft, appendTerminalSelectionToDraft, captureSelection, formatIdeSelection } from './services/contextBridge'
import { focusTerminal, destroyTerminal } from './services/terminal-registry'
import { emitSessionCreated, onSessionRename } from './services/session-events'
import { initSharedReadState } from './services/readState'
import { getDefaultSessionEnvMode } from './services/sessionEnvMode'
import {
  createDesktopNewChatCoordinator,
  retainedWorktreeCreationKey,
  retryDesktopWorktreeCreation,
  shouldDismissDesktopWorktreeSnapshot,
  type DesktopNewChatCoordinator,
} from './services/desktopNewChatCreation'
import { createDesktopNewChatJournal } from './services/desktopNewChatJournal'
import { WorktreeCreationProgress } from './components/worktree/WorktreeCreationProgress'
import type { WorktreeCreationRecoveryAction, WorktreeCreationSnapshot } from '@shared/worktree-creation'
import { newChatKey } from './services/newChatGuard'
import type { SessionSummary, ChatMessage } from '@shared/types'
import { SETTING_DEFAULT_RUNTIME_MODE } from '@shared/session-defaults'
import { needsMessageReload, resolveSessionDisplayTitle, resolveSessionOpenAgentType, resolveSessionResumeId, resolveSessionSelectTarget, shouldEvictMessages, shouldRetrySessionLoadAfterCreate } from './utils/session-eviction'
import { createRendererLogger } from './logger'
import { focusComposer } from './services/composerRegistry'
import { useDraftStore } from './stores/draft-store'
import { nextChatPresentation, nextDualChatShortcutAction, shouldEvictReplacedSession, shouldShowChatFocusIndicator, type ChatPresentation } from './services/chatWorkspace'

const log = createRendererLogger('app')

function toggleDualChatWorkspace(openPicker: () => void): void {
  const layout = useLayoutStore.getState()
  if (nextDualChatShortcutAction(layout) === 'close-secondary') {
    layout.closeChatSlot('secondary')
  } else {
    openPicker()
  }
}

/** Map a SessionSummary's provider `source` to the agent-store's `AgentType`. */
function agentTypeForSource(source: SessionSummary['source']): 'claude-code' | 'codex' | 'opencode' {
  if (source === 'codex') return 'codex'
  if (source === 'opencode') return 'opencode'
  return 'claude-code'
}

/**
 * Root layout - flat flex row, no nesting.
 * All panels always mounted. Toggles use visibility:hidden + width:0.
 * Resize handles manipulate DOM directly during drag.
 */
export function App() {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  // Chat column wrapper - the resize target while data scientist mode has
  // the chat docked right (the right pane is flex:1 then, not resizable).
  const dsChatRef = useRef<HTMLDivElement>(null)
  const newChatCoordinators = useRef(new Map<string, DesktopNewChatCoordinator>())
  const newChatJournal = useRef(createDesktopNewChatJournal(window.localStorage))
  const [worktreeCreationSnapshots, setWorktreeCreationSnapshots] = useState<Record<string, WorktreeCreationSnapshot>>({})
  const newChatCheckoutChoiceRef = useRef<{
    projectPath: string
    machineId: string
    guardKey: string
    recommendedCheckout: NewChatCheckout
  } | null>(null)
  const newChatChoiceOpening = useRef(false)
  const [newChatCheckoutChoice, setNewChatCheckoutChoice] = useState(newChatCheckoutChoiceRef.current)

  const {
    sidebarWidth,
    terminalWidth,
    sidebarVisible,
    terminalVisible,
    toggleSidebar,
    toggleTerminal,
    setSidebarWidth,
    setTerminalWidth,
    registerSidebarEl,
    registerTerminalEl,
    rightPaneMode,
    toggleRightPaneMode,
    appView,
    dataScienceMode,
  } = useLayoutStore()

  // Track viewport width so the panes' max width can be viewport-relative
  // (no fixed cap) while still keeping the chat + the opposite pane's handle
  // on screen. Updated on window resize.
  const [viewportW, setViewportW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1600))
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const sidebarMax = paneMaxWidth(140, terminalVisible ? terminalWidth : 0, viewportW)
  const terminalMax = paneMaxWidth(200, sidebarVisible ? sidebarWidth : 0, viewportW)

  // Select actions individually (stable identities) so App does NOT subscribe
  // to the whole agent store - a bare useAgentStore() re-renders the entire
  // app tree on every streamed token of any session.
  const addSession = useAgentStore((s) => s.addSession)
  const selectChatSession = useLayoutStore((s) => s.selectChatSession)
  const openChatBeside = useLayoutStore((s) => s.openChatBeside)
  const setMessages = useAgentStore((s) => s.setMessages)
  const clearMessages = useAgentStore((s) => s.clearMessages)
  const setTitle = useAgentStore((s) => s.setTitle)
  const { loadSavedTheme } = useThemeStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [quickPromptOpen, setQuickPromptOpen] = useState(false)
  // Refs mirror modal-open state so the keybinding effect (which only
  // depends on toggle callbacks) reads fresh values without re-binding
  // listeners on every state change.
  const modalStateRef = useRef({ settings: false, palette: false, search: false, picker: false, quickPrompt: false })
  modalStateRef.current = {
    settings: settingsOpen,
    palette: paletteOpen,
    search: searchOpen,
    picker: sessionPickerOpen,
    quickPrompt: quickPromptOpen,
  }
  const [appToast, setAppToast] = useState<string | null>(null)
  const [tourOpen, setTourOpen] = useState(false)
  const [tourStartAt, setTourStartAt] = useState(0)

  useEffect(() => {
    const onUnavailable = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      setAppToast(`Context was kept for ${sessionId?.slice(0, 12) ?? 'the closed chat'}, but that chat is no longer open. Reopen it to recover the draft.`)
    }
    window.addEventListener('sb-context-target-unavailable', onUnavailable)
    return () => window.removeEventListener('sb-context-target-unavailable', onUnavailable)
  }, [])

  // First-run / what's-new gating: open the tour automatically when
  // `tour.lastSeenVersion` is missing or older than TOUR_VERSION, unless
  // the user has switched off `tour.autoplay`. Settings tab provides a
  // manual replay path either way.
  // Terminal intent inside the workbench (ctrl+` or cmd+j): the webview
  // swallows Switchboard's global keys, so the bridge forwards it - flip the
  // right pane to the terminal strip.
  useEffect(() =>
    window.api.ide.onTerminalRequest(() => {
      const layout = useLayoutStore.getState()
      layout.setRightPaneMode('terminal')
      if (!layout.terminalVisible) layout.toggleTerminal()
      // Pull focus out of the workbench webview into the terminal so app-level
      // keys (cmd+b toggles the Switchboard sidebar) work again.
      const sid = useLayoutStore.getState().companionSessionId()
      const pid = sid ? useTerminalStore.getState().getActivePaneId(sid) : null
      if (pid) setTimeout(() => focusTerminal(pid), 40)
    }), [])

  // cmd+shift+J inside the workbench webview: VS Code owns the keys there, so
  // the sb-bridge forwards the intent and we toggle data scientist mode here.
  useEffect(() =>
    window.api.ide.onDsModeRequest(() => {
      const layout = useLayoutStore.getState()
      layout.toggleDataScienceMode()
      if (!layout.terminalVisible) layout.toggleTerminal()
    }), [])

  // Workbench selections: cmd+l appends a draft pill; cmd+k (intent 'edit')
  // opens the quick prompt pre-filled with the selection - Cursor-style, but
  // the edit runs through the active agent + in-chat diff review.
  const [ideEditContext, setIdeEditContext] = useState<{ sessionId: string; preview: string; full: string } | null>(null)
  useEffect(() =>
    window.api.ide.onSelection((msg) => {
      if (msg.intent === 'edit') {
        const formatted = formatIdeSelection(msg)
        if (!formatted) return
        setIdeEditContext({ sessionId: formatted.sessionId, preview: formatted.label, full: formatted.block })
        setQuickPromptOpen(true)
      } else {
        appendIdeSelectionToDraft(msg)
      }
    }), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [seen, autoplay] = await Promise.all([
          window.api.settings.get('tour.lastSeenVersion'),
          window.api.settings.get('tour.autoplay'),
        ])
        if (cancelled) return
        const autoplayOn = autoplay !== 'false' // default true
        if (autoplayOn && seen !== TOUR_VERSION) {
          // Defer one tick so first render settles before the modal mounts
          setTimeout(() => { if (!cancelled) { setTourStartAt(0); setTourOpen(true) } }, 400)
        }
      } catch { /* settings unavailable - silently skip auto-open */ }
    })()
    return () => { cancelled = true }
  }, [])

  const handleTryIt = useCallback((action: TryItAction) => {
    if (action.kind === 'focus-chat-with-slash') {
      // Focus the chat input and pre-type "/". ChatInput owns its own
      setTimeout(() => {
        const sessionId = useLayoutStore.getState().focusedChatSessionId()
        if (!sessionId) return
        useDraftStore.getState().setDraft(sessionId, '/')
        focusComposer(sessionId)
      }, 50)
    } else if (action.kind === 'open-search') {
      setSearchOpen(true)
    } else if (action.kind === 'open-settings') {
      setSettingsOpen(true)
    }
  }, [])

  // Listen for an explicit "replay tour" event so SettingsModal (which
  // doesn't own this state) can trigger the modal without prop-drilling.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ startAt?: number }>).detail
      setTourStartAt(detail?.startAt ?? 0)
      setSettingsOpen(false)
      setTourOpen(true)
    }
    window.addEventListener('tour:replay', handler)
    return () => window.removeEventListener('tour:replay', handler)
  }, [])

  // Toast when a session's launch config was deleted from launch-config.yaml and
  // we fell back to default. Auto-dismisses after 4s.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ removedName: string; fallbackName: string }>).detail
      if (!detail) return
      setAppToast(`Launch config "${detail.removedName}" was removed; using ${detail.fallbackName}`)
    }
    window.addEventListener('sb-launch-config-fallback', handler)
    return () => window.removeEventListener('sb-launch-config-fallback', handler)
  }, [])

  useEffect(() => {
    if (!appToast) return
    const t = setTimeout(() => setAppToast(null), 4000)
    return () => clearTimeout(t)
  }, [appToast])

  // Load bookmarks on mount
  useEffect(() => { void useBookmarkStore.getState().load() }, [])

  // Unread is shared with the phone, so opening a chat here clears it there.
  useEffect(() => initSharedReadState(), [])

  // Slot bindings follow the set of renderer sessions through one reducer.
  // This covers live-session adoption, archives/removals, and restored layout
  // state whose conversations no longer exist. The legacy active id is used
  // only to seed an otherwise empty primary slot during startup.
  useEffect(() => {
    let previousIds = ''
    const sync = (state: ReturnType<typeof useAgentStore.getState>) => {
      const ids = state.sessions.map((session) => session.id)
      const key = state.sessions
        .map((session) => `${session.id}:${session.conversationId ?? session.id}`)
        .join('\u0000')
      if (key === previousIds) return
      previousIds = key
      useLayoutStore.getState().reconcileChatSessions(ids)
      if (!useLayoutStore.getState().primarySessionId) {
        const initial = state.activeSessionId && ids.includes(state.activeSessionId)
          ? state.activeSessionId
          : ids[0]
        if (initial) useLayoutStore.getState().selectChatSession(initial)
      }
    }
    sync(useAgentStore.getState())
    return useAgentStore.subscribe(sync)
  }, [])

  // Machine registry (remote SSH hosts) - hydrate once on launch.
  useEffect(() => {
    void useMachineStore.getState().hydrate()
    void useMachineStore.getState().loadSshHosts()
    void useMachineStore.getState().loadSnapshots()
    const unsubStatus = useMachineStore.getState().subscribeStatus()
    // Keep cached remote sidebar rows in sync with renames - nothing else
    // refreshes a snapshot until the next connect-time sync.
    const unsubRename = onSessionRename((sessionId, title) =>
      useMachineStore.getState().renameSnapshotSession(sessionId, title))
    return () => { unsubStatus(); unsubRename() }
  }, [])

  // Load saved theme on mount
  useEffect(() => {
    loadSavedTheme()
    void hydrateSidebarCollapse()
    // Hydrate the default runtime mode so newly-created chats (sidebar new,
    // kanban card click) seed with the user's last-chosen value instead of
    // the hardcoded 'sandbox'.
    void (async () => {
      try {
        const stored = await window.api?.settings?.get?.(SETTING_DEFAULT_RUNTIME_MODE)
        if (stored === 'plan' || stored === 'sandbox' || stored === 'accept-edits' || stored === 'full-access') {
          setStoreDefaultRuntimeMode(stored as RuntimeMode)
        }
      } catch { /* settings unavailable in tests / first boot */ }
    })()
    // Adopt whatever the backend is already running. A chat started on the
    // phone exists only in the backend until this asks: runtime events are
    // broadcast to every client, but nothing replays the ones from before this
    // window connected, and the store drops events for threads it has no row
    // for. Without this the desktop shows a live chat as idle and never renders
    // its sub-agent messages, which exist nowhere else.
    void (async () => {
      try {
        const live = await window.api?.provider?.listSessions?.()
        if (live?.length) useAgentStore.getState().adoptLiveSessions(live)
      } catch (err) {
        log.warn('could not adopt running backend sessions', err)
      }
    })()
  }, [loadSavedTheme])

  // Safety net: runs AFTER handle's own cleanup. Only reverts state that looks
  // "stuck" (cursor still in resize mode with no handle claiming it).
  useEffect(() => {
    const forceCleanup = () => {
      // Use a microtask so handle listeners fire first
      setTimeout(() => {
        const anyActive = document.querySelector('.pane-resize-handle[data-active="1"]')
        if (!anyActive && document.body.style.cursor.includes('resize')) {
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }
        const overlay = document.getElementById('pane-resize-overlay')
        if (overlay && !anyActive) overlay.remove()
      }, 0)
    }
    window.addEventListener('pointerup', forceCleanup)
    window.addEventListener('pointercancel', forceCleanup)
    window.addEventListener('blur', forceCleanup)
    return () => {
      window.removeEventListener('pointerup', forceCleanup)
      window.removeEventListener('pointercancel', forceCleanup)
      window.removeEventListener('blur', forceCleanup)
    }
  }, [])

  // Intercept external link clicks - open in default browser
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href) return
      // Let internal/hash navigation through
      if (href.startsWith('#') || href.startsWith('javascript:')) return
      // External links: intercept and let main process open in browser
      if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) {
        e.preventDefault()
        e.stopPropagation()
        // Delegates to webContents.setWindowOpenHandler → shell.openExternal
        window.open(href, '_blank', 'noopener,noreferrer')
      }
    }
    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [])

  // macOS fullscreen + translucent: vibrancy is disabled while fullscreen
  // (transparent windows go black). Main process sends this event so we can
  // set a data attr that CSS uses to force solid backgrounds as a fallback.
  useEffect(() => {
    if (typeof window.api?.onFullscreenChanged !== 'function') return
    const remove = window.api.onFullscreenChanged((isFullscreen: boolean) => {
      document.documentElement.dataset.fullscreen = isFullscreen ? 'true' : 'false'
    })
    return () => { remove() }
  }, [])

  // Listen for settings shortcut from native menu
  useEffect(() => {
    if (typeof window.api?.onOpenSettings !== 'function') return
    const remove = window.api.onOpenSettings(() => {
      setSettingsOpen(true)
    })
    return () => { remove() }
  }, [])

  useEffect(() => {
    if (typeof window.api?.onOpenChatBeside !== 'function') return
    return window.api.onOpenChatBeside(() => toggleDualChatWorkspace(() => setSessionPickerOpen(true)))
  }, [])

  // ⌘W  close active TAB (close window when last tab)
  // ⌘⇧W close entire active WINDOW (all tabs)
  // No active window → close the app window.
  useEffect(() => {
    if (typeof window.api?.onClosePaneOrWindow !== 'function') return
    const remove = window.api.onClosePaneOrWindow((opts: { shift?: boolean }) => {
      // Route ⌘W by focus context.
      const focus = classifyCloseFocus(document.activeElement as unknown as ClosestEl | null)
      const layoutState = useLayoutStore.getState()

      // IDE pane → the workbench webview owns its own tab lifecycle; a ⌘W
      // here should not close the app window out from under it.
      if (focus === 'editor') return

      // Chat panel in dual mode → close that panel.
      if (layoutState.secondarySessionId && (focus === 'chat-left' || focus === 'chat-right')) {
        layoutState.closeChatSlot(focus === 'chat-right' ? 'secondary' : 'primary')
        return
      }

      // Only close a terminal when one is actually focused - never from
      // ambiguous focus (that's how ⌘W was killing SSH'd-in ptys).
      if (focus === 'terminal') {
        const sid = useLayoutStore.getState().companionSessionId()
        if (sid) {
          const layout = useTerminalStore.getState().getLayout(sid)
          const wid = layout.activeWindowId
          const win = wid ? layout.windows[wid] : null
          if (win) {
            if (opts.shift) {
              // ⌘⇧W - close the whole window and its tabs
              for (const pid of win.paneIds) destroyTerminal(pid)
              useTerminalStore.getState().removeWindow(sid, wid!)
            } else {
              // ⌘W - close just the active tab (window closes itself if last tab)
              const activePaneId = win.activePaneId
              if (activePaneId) {
                destroyTerminal(activePaneId)
                useTerminalStore.getState().removePane(sid, activePaneId)
              }
            }
            return
          }
        }
        // Terminal focused but no pane to close - close the app window.
        window.api.closeWindow?.()
      }
      // 'other' / ambiguous focus → do nothing (no destructive close).
    })
    return () => { remove() }
  }, [])

  // "+ New Chat" submits one backend-owned creation intent. Worktree mode
  // never falls through to the parent checkout: that is a separate recovery
  // action the user must choose explicitly.
  const publishAuthoritativeSession = useCallback((session: {
    id: string
    type: 'claude-code' | 'codex' | 'opencode'
    status: 'idle'
    projectPath: string
    machineId: string
    worktreeId?: string
    worktreePath?: string
    worktreeBranch?: string
    managedTerminalIds?: string[]
    title: string
    runtimeMode: RuntimeMode
  }) => {
    window.api.routing.bind(session.id, session.machineId)
    if (session.managedTerminalIds?.length && session.worktreePath) {
      useTerminalStore.getState().adoptManagedTerminals(
        session.id,
        session.managedTerminalIds,
        session.worktreePath,
      )
    }
    addSession(session)
    selectChatSession(session.id)
    if (session.machineId === 'local') {
      emitSessionCreated({
        id: session.id,
        projectPath: session.projectPath,
        title: session.title,
        startedAt: Date.now(),
        source: 'switchboard',
      })
    } else {
      useMachineStore.getState().addSnapshotSession(session.machineId, session.projectPath, {
        id: session.id,
        title: session.title,
        agentType: session.type,
      })
    }
  }, [addSession, selectChatSession])

  const makeNewChatCoordinator = useCallback(() => createDesktopNewChatCoordinator({
    worktrees: {
      create: window.api.worktreeCreation.create,
      get: window.api.worktreeCreation.get,
      onProgress: window.api.worktreeCreation.onProgress,
    },
    sessions: { addAuthoritative: publishAuthoritativeSession },
    parent: {
      create: async (intent) => {
        window.api.routing.bind(intent.conversationId, intent.machineId)
        await window.api.app.createConversation({
          id: intent.conversationId,
          projectPath: intent.projectPath,
          agentType: intent.agentType,
          title: intent.title,
        })
        publishAuthoritativeSession({
          id: intent.conversationId,
          type: intent.agentType,
          status: 'idle',
          projectPath: intent.projectPath,
          machineId: intent.machineId,
          title: intent.title,
          runtimeMode: intent.runtimeMode,
        })
        return { conversationId: intent.conversationId }
      },
    },
    journal: newChatJournal.current,
    createId: () => crypto.randomUUID(),
    now: Date.now,
    onStateChange: (state) => {
      if (!state.creationId || !state.snapshot) return
      if (state.snapshot.status === 'ready' || shouldDismissDesktopWorktreeSnapshot(state.snapshot)) {
        newChatJournal.current.remove(state.creationId)
        setWorktreeCreationSnapshots((current) => {
          const next = { ...current }
          delete next[state.creationId!]
          return next
        })
      } else {
        setWorktreeCreationSnapshots((current) => ({
          ...current,
          [state.creationId!]: state.snapshot!,
        }))
      }
    },
  }), [publishAuthoritativeSession])

  const newChatPending = useRef(new Set<string>())
  const [pendingNewChats, setPendingNewChats] = useState<ReadonlySet<string>>(new Set())
  const releaseNewChatGuard = useCallback((guardKey: string) => {
    newChatPending.current.delete(guardKey)
    setPendingNewChats(new Set(newChatPending.current))
  }, [])

  const handleNewChat = useCallback(
    async (projectPath: string, machineId: string = 'local') => {
      // Worktree creation takes seconds (longer over SSH), so the buttons
      // look dead and users click again, getting duplicate worktrees and
      // conversation rows. Keyed per project + machine so A never blocks B.
      const guardKey = newChatKey(projectPath, machineId)
      if (newChatPending.current.has(guardKey)) return
      if (newChatCheckoutChoiceRef.current || newChatChoiceOpening.current) return
      newChatPending.current.add(guardKey)
      setPendingNewChats(new Set(newChatPending.current))
      newChatChoiceOpening.current = true
      try {
        const mode = await getDefaultSessionEnvMode()
        const choice = {
          projectPath,
          machineId,
          guardKey,
          recommendedCheckout: mode === 'worktree' ? 'worktree' as const : 'project' as const,
        }
        newChatCheckoutChoiceRef.current = choice
        setNewChatCheckoutChoice(choice)
      } catch (error) {
        releaseNewChatGuard(guardKey)
        setAppToast(error instanceof Error ? error.message : 'Could not prepare the new conversation.')
      } finally {
        newChatChoiceOpening.current = false
      }
    },
    [releaseNewChatGuard],
  )

  const confirmNewChatCheckout = useCallback(async (checkout: NewChatCheckout) => {
    const choice = newChatCheckoutChoiceRef.current
    if (!choice) return
    newChatCheckoutChoiceRef.current = null
    setNewChatCheckoutChoice(null)
    const coordinator = makeNewChatCoordinator()
    try {
      useLayoutStore.getState().setAppView('chats')
      const state = await coordinator.start({
        projectPath: choice.projectPath,
        machineId: choice.machineId,
        checkout,
        agentType: 'claude-code',
        runtimeMode: useAgentStore.getState().getActiveSession()?.runtimeMode ?? 'sandbox',
      })
      if (
        checkout === 'worktree'
        && state.creationId
        && state.status !== 'ready'
        && (!state.snapshot || !shouldDismissDesktopWorktreeSnapshot(state.snapshot))
      ) {
        newChatCoordinators.current.set(state.creationId, coordinator)
      } else {
        coordinator.dismiss()
        coordinator.dispose()
      }
      if (state.status === 'failed') setAppToast(state.error ?? 'The worktree conversation was not started.')
    } catch (error) {
      const state = coordinator.state()
      if (
        checkout === 'worktree'
        && state.creationId
        && state.status !== 'ready'
        && (!state.snapshot || !shouldDismissDesktopWorktreeSnapshot(state.snapshot))
      ) {
        newChatCoordinators.current.set(state.creationId, coordinator)
      } else {
        coordinator.dismiss()
        coordinator.dispose()
      }
      setAppToast(error instanceof Error ? error.message : 'Could not start the new conversation.')
    } finally {
      releaseNewChatGuard(choice.guardKey)
    }
  }, [makeNewChatCoordinator, releaseNewChatGuard])

  const cancelNewChatCheckout = useCallback(() => {
    const choice = newChatCheckoutChoiceRef.current
    if (!choice) return
    newChatCheckoutChoiceRef.current = null
    setNewChatCheckoutChoice(null)
    releaseNewChatGuard(choice.guardKey)
  }, [releaseNewChatGuard])

  const handleWorktreeCreationAction = useCallback(async (
    snapshot: WorktreeCreationSnapshot,
    action: WorktreeCreationRecoveryAction,
  ) => {
    const coordinator = newChatCoordinators.current.get(snapshot.creationId)
    if (!snapshot) return
    try {
      if (action === 'start_in_project') {
        if (!coordinator) {
          throw new Error('The original new-chat request is unavailable. Retry or remove the retained worktree.')
        }
        await coordinator.startInProject()
        setWorktreeCreationSnapshots((current) => {
          const next = { ...current }
          delete next[snapshot.creationId]
          return next
        })
        coordinator.dispose()
        newChatCoordinators.current.delete(snapshot.creationId)
        return
      }
      const result = coordinator
        ? await retryDesktopWorktreeCreation({
            snapshot,
            action,
            reconcile: () => coordinator.reconcile(),
            act: (request) => window.api.worktreeCreation.act(request),
          })
        : await window.api.worktreeCreation.act({
            creationId: snapshot.creationId,
            machineId: snapshot.provenance.machineId,
            expectedRevision: snapshot.revision,
            action,
          })
      if (!('phase' in result)) return
      const updated = result
      if (shouldDismissDesktopWorktreeSnapshot(updated)) {
        coordinator?.dismiss()
        coordinator?.dispose()
        newChatCoordinators.current.delete(snapshot.creationId)
        setWorktreeCreationSnapshots((current) => {
          const next = { ...current }
          delete next[snapshot.creationId]
          return next
        })
        return
      }
      setWorktreeCreationSnapshots((current) => ({ ...current, [snapshot.creationId]: updated }))
      if (updated.status === 'ready' && coordinator) {
        await coordinator.reconcile()
        coordinator.dispose()
        newChatCoordinators.current.delete(snapshot.creationId)
        setWorktreeCreationSnapshots((current) => {
          const next = { ...current }
          delete next[snapshot.creationId]
          return next
        })
      }
    } catch (error) {
      setAppToast(error instanceof Error ? error.message : 'Could not update worktree creation.')
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const restored: DesktopNewChatCoordinator[] = []
    for (const entry of newChatJournal.current.list()) {
      const coordinator = makeNewChatCoordinator()
      restored.push(coordinator)
      newChatCoordinators.current.set(entry.request.creationId, coordinator)
      void coordinator.restore(entry).then((state) => {
        if (state.snapshot && (
          state.snapshot.status === 'ready'
          || shouldDismissDesktopWorktreeSnapshot(state.snapshot)
        )) {
          coordinator.dismiss()
          coordinator.dispose()
          newChatCoordinators.current.delete(entry.request.creationId)
        }
      }).catch((error) => {
        if (!disposed) setAppToast(error instanceof Error ? error.message : 'Could not reconcile worktree creation.')
      })
    }
    return () => {
      disposed = true
      for (const coordinator of restored) coordinator.dispose()
    }
  }, [makeNewChatCoordinator])

  const isNewChatPending = useCallback(
    (projectPath: string, machineId: string = 'local') =>
      pendingNewChats.has(newChatKey(projectPath, machineId)),
    [pendingNewChats],
  )

  // Click a session in sidebar - load its messages from disk. If we're
  // in kanban view, drop back to chats so the user actually sees the
  // session they just clicked.
  const handleSessionSelect = useCallback(
    async (
      session: SessionSummary,
      projectPath: string,
      machineId: string = 'local',
      placement: 'select' | 'beside' = 'select',
    ) => {
      useLayoutStore.getState().setAppView('chats')
      // Terminal summaries are companion surfaces, not chats. Treat an
      // "open beside" request from a generic sidebar menu as an ordinary
      // selection so a terminal can never occupy the secondary chat slot.
      const placeSession = placement === 'beside' && session.agentType !== 'terminal'
        ? openChatBeside
        : selectChatSession

      const recoveryKey = retainedWorktreeCreationKey(session, machineId)
      if (recoveryKey) {
        try {
          const snapshot = await window.api.worktreeCreation.get(recoveryKey)
          setWorktreeCreationSnapshots((current) => ({ ...current, [snapshot.creationId]: snapshot }))
        } catch (error) {
          setAppToast(error instanceof Error ? error.message : 'Could not load retained worktree recovery.')
        }
        return
      }

      // Callers that don't track the machine (e.g. bookmarks) default to 'local';
      // prefer the machine the store already knows so we don't clobber a remote binding.
      const storeState = useAgentStore.getState()
      const existing = storeState.sessions.find((s) => s.id === session.id)
      const effectiveMachineId = existing?.machineId ?? machineId

      // Route every backend call for this session (load, createConversation,
      // startSession, sendTurn) to its machine before the first one fires.
      // Keyed by session.id, which is arg0 of all those calls.
      window.api.routing.bind(session.id, effectiveMachineId)

      const currentId = useLayoutStore.getState().focusedChatSessionId()
      const current = storeState.sessions.find((s) => s.id === currentId)
      const placeAndEvict = (sessionId: string) => {
        placeSession(sessionId)
        if (
          current
          && shouldEvictMessages(current)
          && shouldEvictReplacedSession(
            current.id,
            useLayoutStore.getState().displayedChatSessionIds(),
          )
        ) {
          clearMessages(current.id)
        }
      }

      if (existing) {
        placeAndEvict(session.id)
        setTitle(session.id, resolveSessionDisplayTitle(session.title, existing.title))
        // Messages may have been evicted - reload from disk if so.
        if (needsMessageReload(existing)) {
          try {
            const resp = await window.api.app.loadSessionById(session.id) as {
              messages: ChatMessage[]
              meta: { id: string; title: string; projectPath: string; agentType: string } | null
            }
            if (resp?.messages?.length) {
              setMessages(session.id, resp.messages)
            } else if (effectiveMachineId !== 'local') {
              // Empty reload for a remote chat means routing/scan failure, not
              // an empty conversation.
              log.warn('remote history reload returned no messages', { sessionId: session.id, machineId: effectiveMachineId })
            }
          } catch (err) {
            log.warn('session history reload failed', { sessionId: session.id, machineId: effectiveMachineId, err })
          }
        }
        return
      }

      // Terminal sessions have no JSONL - PTY is gone after restart, just activate.
      if (session.agentType === 'terminal') {
        addSession({ id: session.id, type: 'terminal', status: 'idle', projectPath, title: session.title, machineId: effectiveMachineId })
        placeAndEvict(session.id)
        return
      }

      // Load before creating anything: the response carries `rootThreadId`, so
      // a click on a rotated id can activate the live thread instead of
      // building a twin next to it.
      type LoadedSession = {
        messages: ChatMessage[]
        meta: {
          id: string
          title: string
          projectPath: string
          agentType: string
          rootThreadId?: string
          worktreePath?: string | null
          worktreeBranch?: string | null
          worktreeId?: string | null
          providerInstanceId?: string | null
          runtimeMode?: 'plan' | 'sandbox' | 'accept-edits' | 'full-access' | null
          model?: string | null
          reasoningEffort?: 'low' | 'medium' | 'high' | null
          launchConfigName?: string | null
          forkMetadata?: import('@shared/conversation-fork').ForkLineageMetadata | null
        } | null
      }
      let loaded: LoadedSession | null = null
      try {
        loaded = await window.api.app.loadSessionById(session.id) as LoadedSession
      } catch (err) {
        log.warn('session history load failed', { sessionId: session.id, machineId: effectiveMachineId, err })
      }

      const targetId = resolveSessionSelectTarget(
        session.id,
        loaded?.meta?.rootThreadId,
        useAgentStore.getState().sessions.map((s) => s.id),
      )
      if (targetId !== session.id) {
        const live = useAgentStore.getState().sessions.find((s) => s.id === targetId)
        window.api.routing.bind(targetId, live?.machineId ?? effectiveMachineId)
        placeAndEvict(targetId)
        return
      }

      // First open: create session in store - pass session.id as resumeSessionId
      // so Claude CLI can --resume the conversation. Hydrate the
      // worktree pointer so a session that was created in worktree
      // mode resumes in its worktree, not the parent repo.
      let creationSnapshot: WorktreeCreationSnapshot | null = null
      if (session.worktreeCreationId) {
        try {
          creationSnapshot = await window.api.worktreeCreation.get({
            creationId: session.worktreeCreationId,
            machineId: effectiveMachineId,
          })
          if (creationSnapshot.startupReceipt?.terminalIds.length && creationSnapshot.worktreePath) {
            useTerminalStore.getState().adoptManagedTerminals(
              session.id,
              creationSnapshot.startupReceipt.terminalIds,
              creationSnapshot.worktreePath,
            )
          }
        } catch (error) {
          log.warn('worktree startup receipt recovery failed', { sessionId: session.id, error })
        }
      }
      addSession({
        id: session.id,
        type: resolveSessionOpenAgentType(agentTypeForSource(session.source), loaded?.meta?.agentType),
        status: 'idle',
        projectPath: loaded?.meta?.projectPath ?? projectPath,
        machineId: effectiveMachineId,
        worktreeId: loaded?.meta?.worktreeId ?? creationSnapshot?.worktreeId ?? null,
        worktreePath: loaded?.meta?.worktreePath ?? session.worktreePath ?? null,
        worktreeBranch: loaded?.meta?.worktreeBranch ?? session.worktreeBranch ?? null,
        managedTerminalIds: creationSnapshot?.startupReceipt?.terminalIds,
        resumeSessionId: loaded?.meta?.forkMetadata?.resumeMode === 'transcript-handoff'
          ? undefined
          : resolveSessionResumeId(session.source, session.id),
        title: session.title,
        runtimeMode: loaded?.meta?.runtimeMode ?? undefined,
        model: loaded?.meta?.model ?? undefined,
        reasoningEffort: loaded?.meta?.reasoningEffort ?? undefined,
        instanceId: loaded?.meta?.providerInstanceId ?? undefined,
        forkMetadata: loaded?.meta?.forkMetadata ?? session.forkMetadata,
      })
      placeAndEvict(session.id)

      // Ensure conversation row exists in DB so subsequent saveMessage /
      // bulkSaveMessages calls don't skip due to missing FK.
      await window.api.app.createConversation({
        id: session.id,
        projectPath,
        agentType: agentTypeForSource(session.source),
        title: session.title,
      }).catch(() => {})

      if (shouldRetrySessionLoadAfterCreate(Boolean(loaded?.meta), session.filePath)) {
        try {
          loaded = await window.api.app.loadSessionById(session.id) as LoadedSession
        } catch (err) {
          log.warn('session history reload after create failed', { sessionId: session.id, err })
        }
      }

      // Hydrate the persisted runtime mode, provider instance, and pinned
      // model (if the user previously picked one for this conversation).
      // Without this, the pickers show the module default until the user
      // re-toggles, which feels like "the value is hardcoded on chat load."
      // Fired concurrently - the three reads are independent and each has
      // its own failure handling, so there's no reason to pay three
      // sequential round trips (real latency over a remote/WS backend).
      // Each entry is wrapped in an async IIFE, not called bare: the old
      // code gave each call its own try/catch, so a synchronous throw (e.g.
      // a missing method on a degraded transport) only dropped that one
      // field. A bare call here would throw while building this array,
      // before Promise.allSettled exists to catch anything, taking down
      // the rest of handleSessionSelect - including loadSessionById below.
      const [runtimeModeResult, instanceResult, modelResult] = await Promise.allSettled([
        (async () => window.api.app.getConversationRuntimeMode?.(session.id))(),
        (async () => window.api.app.getConversationProviderInstanceId(session.id))(),
        (async () => window.api.app.getConversationModel?.(session.id))(),
      ])
      if (runtimeModeResult.status === 'fulfilled') {
        const persisted = runtimeModeResult.value?.mode
        if (persisted === 'plan' || persisted === 'sandbox' || persisted === 'accept-edits' || persisted === 'full-access') {
          useAgentStore.getState().setRuntimeMode(session.id, persisted)
        }
      } else {
        log.warn('restore runtime mode failed', { sessionId: session.id, err: runtimeModeResult.reason })
      }
      if (instanceResult.status === 'fulfilled') {
        if (instanceResult.value?.instanceId) {
          useAgentStore.getState().setInstanceId(session.id, instanceResult.value.instanceId)
        }
      } else {
        log.warn('restore provider instance failed', { sessionId: session.id, err: instanceResult.reason })
      }
      if (modelResult.status === 'fulfilled') {
        if (modelResult.value?.model) {
          useAgentStore.getState().setModel(session.id, modelResult.value.model)
        }
      } else {
        log.warn('restore pinned model failed', { sessionId: session.id, err: modelResult.reason })
      }

      if (loaded?.messages?.length) setMessages(session.id, loaded.messages)
    },
    [addSession, selectChatSession, openChatBeside, setMessages, clearMessages],
  )

  const handleOpenLoadedSessionBeside = useCallback(async (sessionId: string) => {
    const session = useAgentStore.getState().sessions.find((candidate) => candidate.id === sessionId)
    if (!session) {
      setAppToast('That chat is no longer loaded. Open it from the sidebar and try again.')
      return
    }
    openChatBeside(sessionId)
    if (needsMessageReload(session)) {
      try {
        const loaded = await window.api.app.loadSessionById(sessionId) as { messages?: ChatMessage[] } | null
        if (loaded?.messages?.length) setMessages(sessionId, loaded.messages)
      } catch (err) {
        log.warn('open-beside history reload failed', { sessionId, err })
        setAppToast('The chat opened, but its history could not be reloaded.')
      }
    }
    requestAnimationFrame(() => focusComposer(sessionId))
  }, [openChatBeside, setMessages])

  useEffect(() => {
    registerSidebarEl(sidebarRef.current)
    registerTerminalEl(terminalRef.current)
  }, [registerSidebarEl, registerTerminalEl])

  // The single companion terminal strip follows chat focus, not primary identity.
  const companionAgentSessionId = useLayoutStore((s) =>
    s.focusedChatSlot === 'secondary' && s.secondarySessionId
      ? s.secondarySessionId
      : s.primarySessionId,
  )
  // Narrow to the one primitive we render below (terminal pane id). Selecting
  // the whole session object returned a fresh reference every token and forced
  // a per-token App re-render.
  const activeTerminalPaneId = useAgentStore((s) => {
    const a = s.sessions.find((x) => x.id === companionAgentSessionId)
    return a?.type === 'terminal' ? (a.terminalPaneId ?? null) : null
  })
  const termSetActiveSession = useTerminalStore((s) => s.setActiveSession)

  useEffect(() => {
    termSetActiveSession(companionAgentSessionId)
  }, [companionAgentSessionId, termSetActiveSession])

  // Terminal lifecycle - spawn/kill PTYs on session change
  useTerminalLifecycle()

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault()
          toggleSidebar()
        }
        // ⌘+Shift+J - data scientist mode: workbench center, chat docked right
        else if ((e.key === 'j' || e.key === 'J') && e.shiftKey) {
          e.preventDefault()
          useLayoutStore.getState().toggleDataScienceMode()
          if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
        } else if (e.key === 'j' || e.key === 'J') {
          e.preventDefault()
          toggleTerminal()
        }
        // ⌘+Shift+E - toggle right pane: terminal ↔ files
        else if ((e.key === 'e' || e.key === 'E') && e.shiftKey) {
          e.preventDefault()
          toggleRightPaneMode()
          if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
          // Flipping to terminal: focus it (IdePane focuses the webview on the
          // flip to files). Keeps cmd+b/cmd+p routed to the pane you're in.
          if (useLayoutStore.getState().rightPaneMode === 'terminal') {
            const sid = useLayoutStore.getState().companionSessionId()
            const pid = sid ? useTerminalStore.getState().getActivePaneId(sid) : null
            if (pid) setTimeout(() => focusTerminal(pid), 40)
          }
        }
        // ⌘+Shift+K - toggle top-level app view (chats ↔ kanban board)
        else if ((e.key === 'k' || e.key === 'K') && e.shiftKey) {
          e.preventDefault()
          useLayoutStore.getState().toggleAppView()
        }
        // ⌘+Shift+P - command palette
        else if ((e.key === 'p' || e.key === 'P') && e.shiftKey) {
          e.preventDefault()
          setPaletteOpen((prev) => !prev)
        }
        // ⌘+Shift+F - search across conversations
        else if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
          e.preventDefault()
          setSearchOpen((prev) => !prev)
        }
        // ⌘+⇧+T - new window in a new row (below)
        // ⌘+T    - new window in the same row (right of active)
        //
        // Previously: silently did nothing when `activeSessionId` was
        // null - a bad UX that made the shortcut feel broken. Now:
        // falls back to the first available session; if none exist,
        // logs a helpful console warning so devtools shows the reason.
        else if (e.key.toLowerCase() === 't') {
          e.preventDefault()
          const agentState = useAgentStore.getState()
          let sid = useLayoutStore.getState().companionSessionId()
          if (!sid) {
            // Fallback - pick the most recent session so ⌘T still works
            // even if the user hasn't explicitly focused a chat.
            sid = agentState.sessions[0]?.id ?? null
            if (sid) useLayoutStore.getState().selectChatSession(sid)
          }
          if (!sid) {
            log.warn('⌘T: no session available - open or create a chat first')
            return
          }
          const st = useTerminalStore.getState()
          const ids = st.getAllWindowIds(sid)
          const label = `Terminal ${ids.length + 1}`
          const cwd = agentState.sessions.find((s) => s.id === sid)?.projectPath
          const direction: 'column' | 'row' = e.shiftKey ? 'column' : 'row'
          const ref = ids.length === 0
            ? st.addWindow(sid, { label, cwd })
            : st.splitActiveWindow(sid, direction, { label, cwd })
          if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
          if (ref) setTimeout(() => focusTerminal(ref.paneId), 80)
        }
        // ⌘+Shift+| - toggle dual-chat mode (opens rightmost inactive
        // session on the right, or closes if already dual). When opening,
        // pick the most-recent session that isn't the currently active one.
        //
        else if (e.key === '|' || (e.key === '\\' && e.shiftKey)) {
          e.preventDefault()
          toggleDualChatWorkspace(() => setSessionPickerOpen(true))
        }
        // ⌘+Backspace - interrupt the current agent turn. xterm's helper
        // textarea counts as text input so ⌘+Delete keeps its line-kill behavior.
        else if (e.key === 'Backspace' && !e.shiftKey && !e.altKey) {
          const sid = useLayoutStore.getState().focusedChatSessionId()
          const s = useAgentStore.getState().sessions.find((x) => x.id === sid)
          if (s && (s.status === 'running' || s.status === 'thinking')) {
            const active = document.activeElement
            const inText = active instanceof HTMLElement && (
              active.tagName === 'INPUT' ||
              active.tagName === 'TEXTAREA' ||
              active.contentEditable === 'true'
            )
            if (!inText && sid) {
              e.preventDefault()
              window.api.provider?.interrupt?.(sid).catch(() => {})
            }
          }
        }
        // ⌘+L - context bridge: append active terminal selection to the
        // chat draft. User types their question after the pasted context
        // and hits Send as normal.
        else if ((e.key === 'l' || e.key === 'L') && !e.shiftKey) {
          e.preventDefault()
          // Routes by `data-context-source` on the selection's anchor:
          // terminal | file-viewer | chat-message. Falls back to legacy
          // terminal-only flow when nothing is wired up.
          const appended = captureSelection()
          if (!appended) {
            log.info('⌘L: no selection - select text in a terminal, file viewer, or chat message first')
          }
        }
        // ⌘+K - quick prompt: open the floating prompt bar. Pre-fills
        // with the current terminal selection as context (if any).
        else if (e.key === 'k' || e.key === 'K') {
          e.preventDefault()
          setQuickPromptOpen(true)
        }
        // ⌘+\ - new tab in the active window
        else if (e.key === '\\' && !e.shiftKey) {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            e.preventDefault()
            const st = useTerminalStore.getState()
            const ids = st.getAllPaneIds(sid)
            const cwd = useAgentStore.getState().sessions.find((s) => s.id === sid)?.projectPath
            const pid = st.addPaneToActiveWindow(sid, { label: `Terminal ${ids.length + 1}`, cwd })
            if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
            if (pid) setTimeout(() => focusTerminal(pid), 80)
          }
        }
        // ⌘+⇧+] - next tab in active window
        else if (e.key === '}' || (e.key === ']' && e.shiftKey)) {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            e.preventDefault()
            useTerminalStore.getState().cyclePane(sid, 'next')
            const pid = useTerminalStore.getState().getActivePaneId(sid)
            if (pid) setTimeout(() => focusTerminal(pid), 40)
          }
        }
        // ⌘+⇧+[ - prev tab in active window
        else if (e.key === '{' || (e.key === '[' && e.shiftKey)) {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            e.preventDefault()
            useTerminalStore.getState().cyclePane(sid, 'prev')
            const pid = useTerminalStore.getState().getActivePaneId(sid)
            if (pid) setTimeout(() => focusTerminal(pid), 40)
          }
        }
        // ⌘+⌥+Arrow - navigate between windows directionally
        else if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          const sid = useLayoutStore.getState().companionSessionId()
          if (!sid) return
          e.preventDefault()
          const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
          useTerminalStore.getState().focusDirection(sid, dirMap[e.key as keyof typeof dirMap])
          const pid = useTerminalStore.getState().getActivePaneId(sid)
          if (pid) setTimeout(() => focusTerminal(pid), 40)
        }
        // ⌘+1..9 - focus window by index
        else if (e.key >= '1' && e.key <= '9') {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            const index = parseInt(e.key) - 1
            const ids = useTerminalStore.getState().getAllWindowIds(sid)
            if (index < ids.length) {
              e.preventDefault()
              useTerminalStore.getState().focusWindowByIndex(sid, index)
              const pid = useTerminalStore.getState().getActivePaneId(sid)
              if (pid) setTimeout(() => focusTerminal(pid), 50)
            }
          }
        }
      }
    }
    // Capture phase so we get events before element-level handlers (xterm, etc.)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [toggleSidebar, toggleTerminal, toggleRightPaneMode])

  const handleSidebarResizeEnd = useCallback(
    (px: number) => setSidebarWidth(px),
    [setSidebarWidth],
  )

  const handleTerminalResizeEnd = useCallback(
    (px: number) => setTerminalWidth(px),
    [setTerminalWidth],
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Titlebar */}
      <div
        className="titlebar-drag"
        style={{
          height: 'var(--titlebar-height)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid var(--border)',
          fontSize: '12px',
          color: 'var(--text-muted)',
          userSelect: 'none',
        }}
      >
        <span style={{ flex: 1 }} />
        <span style={{ fontWeight: 500, letterSpacing: '0.3px' }}>Switchboard</span>
        <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: '12px', alignItems: 'center', gap: '8px' }}>
          {/* Chats ↔ Board view toggle. ⌘⇧K does the same thing - this
              gives discoverability for users who don't know the shortcut. */}
          <ViewToggle />
          <button
            onClick={() => setSettingsOpen(true)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              WebkitAppRegion: 'no-drag',
              transition: 'color 0.12s',
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'var(--text-muted)' }}
            title="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </span>
      </div>

      {/* Body - flat flex row, all panels always mounted. The chat +
           terminal stack and the kanban view are siblings; we toggle
           between them with `display: none` so xterm/PTY state and the
           Shiki cache survive the swap (same pattern as the right-pane
           terminal↔files toggle). Avoids the translucent-theme bleed-
           through that an absolute overlay caused. */}
      <div style={{ flex: '1 1 0%', display: 'flex', minHeight: 0 }}>
        {/* Sidebar - width + visibility driven from JSX (not imperatively
             mutated in the store) so React reconciles drag-time writes
             back to state on the next commit. See layout-store.ts. */}
        <div
          ref={sidebarRef}
          style={{
            width: sidebarVisible ? `${sidebarWidth}px` : '0px',
            visibility: sidebarVisible ? 'visible' : 'hidden',
            flexShrink: 0,
            overflow: 'hidden',
            display: 'flex',
            borderRight: sidebarVisible ? '1px solid var(--border)' : 'none',
          }}
        >
          <Sidebar
            onNewChat={handleNewChat}
            onSessionSelect={handleSessionSelect}
            onOpenBeside={(session, projectPath, machineId) => {
              void handleSessionSelect(session, projectPath, machineId, 'beside')
            }}
            isNewChatPending={isNewChatPending}
          />
        </div>

        {/* Sidebar divider */}
        <ResizeHandle
          direction="horizontal"
          beforeRef={sidebarRef}
          min={140}
          max={sidebarMax}
          onResizeEnd={handleSidebarResizeEnd}
          visible={sidebarVisible}
          handleId="sidebar"
        />

        {/* Engineering view: chat + terminal stack. Hidden (not unmounted)
            when the user switches to the board view - preserves PTY +
            xterm + Shiki state across toggles. */}
        <div
          style={{
            flex: '1 1 0%',
            display: appView === 'chats' ? 'flex' : 'none',
            minWidth: 0,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* Chat - fills remaining space; dual mode renders two ChatPanels.
              Data scientist mode (⌘⇧J) swaps size + flex-order with the right
              pane (CSS-only, panes stay mounted). */}
          <div
            ref={dsChatRef}
            style={
              dataScienceMode
                ? {
                    width: terminalVisible ? `${terminalWidth}px` : '0px',
                    visibility: terminalVisible ? 'visible' : 'hidden',
                    flexShrink: 0,
                    overflow: 'hidden',
                    display: 'flex',
                    order: 3,
                    borderLeft: terminalVisible ? '1px solid var(--border)' : 'none',
                  }
                : { flex: '1 1 0%', display: 'flex', minWidth: 0, overflow: 'hidden' }
            }
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                display: activeTerminalPaneId ? 'none' : 'flex',
                minWidth: 0,
              }}
            >
              <ChatWorkspacePanels
                dataScienceMode={dataScienceMode}
                onOpenBeside={() => setSessionPickerOpen(true)}
              />
            </div>
            {activeTerminalPaneId && (
              <div style={{ width: '100%', height: '100%', display: 'flex', minWidth: 0 }}>
                <TerminalSessionPane paneId={activeTerminalPaneId} sessionId={companionAgentSessionId!} />
              </div>
            )}
          </div>

          {/* Terminal divider - `beforeRef` intentionally omitted; the chat
              panel between sidebar and terminal is flex:1, no width to pin.
              Wiring sidebarRef here causes the "can't resize either pane"
              bug; pinned by tests/unit/resize-handle-wiring.test.ts. */}
          <ResizeHandle
            direction="horizontal"
            afterRef={dataScienceMode ? dsChatRef : terminalRef}
            invert
            min={200}
            max={terminalMax}
            onResizeEnd={handleTerminalResizeEnd}
            visible={terminalVisible}
            handleId="terminal"
            {...(dataScienceMode ? { style: { order: 2 } } : {})}
          />

          {/* Right pane: terminal OR files (⌘⇧E), both stay mounted. Takes
               the wide center slot in data scientist mode. */}
          <div
            ref={terminalRef}
            style={
              dataScienceMode
                ? {
                    flex: '1 1 0%',
                    minWidth: 0,
                    overflow: 'hidden',
                    display: 'flex',
                    order: 1,
                    position: 'relative',
                  }
                : {
                    width: terminalVisible ? `${terminalWidth}px` : '0px',
                    visibility: terminalVisible ? 'visible' : 'hidden',
                    flexShrink: 0,
                    overflow: 'hidden',
                    display: 'flex',
                    borderLeft: terminalVisible ? '1px solid var(--border)' : 'none',
                    position: 'relative',
                  }
            }
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: rightPaneMode === 'terminal' ? 'flex' : 'none',
              }}
            >
              <TerminalStrip />
            </div>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: rightPaneMode === 'files' ? 'flex' : 'none',
              }}
            >
              <IdePane />
            </div>
          </div>
        </div>

        {/* PM view: kanban board. Always mounted so the project +
            workspace lists and the filter dropdowns stay warm across
            toggles - unmounting on every swap was causing a visible
            empty-dropdown flicker every time the user came back. */}
        <div
          style={{
            flex: '1 1 0%',
            display: appView === 'kanban' ? 'flex' : 'none',
            minWidth: 0,
          }}
        >
          <KanbanView />
        </div>
      </div>

      <StatusBar />

      {newChatCheckoutChoice && (
        <NewChatCheckoutDialog
          projectPath={newChatCheckoutChoice.projectPath}
          machineId={newChatCheckoutChoice.machineId}
          recommendedCheckout={newChatCheckoutChoice.recommendedCheckout}
          onChoose={(checkout) => { void confirmNewChatCheckout(checkout) }}
          onCancel={cancelNewChatCheckout}
        />
      )}

      {Object.values(worktreeCreationSnapshots).some((snapshot) => snapshot.status !== 'ready') && (
        <div style={{
          position: 'fixed', right: 16, bottom: 42, width: 360, zIndex: 1200,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {Object.values(worktreeCreationSnapshots)
            .filter((snapshot) => snapshot.status !== 'ready')
            .map((snapshot) => (
              <WorktreeCreationProgress
                key={snapshot.creationId}
                snapshot={snapshot}
                onAction={(action) => handleWorktreeCreationAction(snapshot, action)}
              />
            ))}
        </div>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => { setPaletteOpen(false); setSettingsOpen(true) }}
        onOpenSearch={() => { setPaletteOpen(false); setSearchOpen(true) }}
        onOpenSessionPicker={() => { setPaletteOpen(false); setSessionPickerOpen(true) }}
        onOpenQuickPrompt={() => { setPaletteOpen(false); setQuickPromptOpen(true) }}
        onContextBridge={() => { setPaletteOpen(false); appendTerminalSelectionToDraft() }}
        onNewChat={handleNewChat}
      />
      <SessionPickerModal
        open={sessionPickerOpen}
        onClose={() => setSessionPickerOpen(false)}
        onPick={(id) => { void handleOpenLoadedSessionBeside(id) }}
        excludeIds={useLayoutStore.getState().displayedChatSessionIds()}
        title="Open a loaded chat beside this one"
      />
      <QuickPromptModal
        open={quickPromptOpen}
        onClose={() => {
          setQuickPromptOpen(false)
          setIdeEditContext(null)
        }}
        ideContext={ideEditContext}
        targetSessionId={ideEditContext?.sessionId}
      />
      <FeatureTourModal
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        startAt={tourStartAt}
        onTryIt={handleTryIt}
      />
      {appToast && (
        <div
          style={{
            position: 'fixed',
            bottom: 36,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '8px 14px',
            fontSize: '12px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 2000,
            maxWidth: '480px',
          }}
        >
          {appToast}
        </div>
      )}
      <UpdateToast />
    </div>
  )
}

/**
 * Segmented "Chats / Board" toggle in the title bar. Mirrors ⌘⇧K so the
 * mode swap is discoverable without the keyboard shortcut. Sits inside
 * the drag region but opts out via WebkitAppRegion: 'no-drag' so clicks
 * land on the buttons.
 */
function ViewToggle(): React.ReactElement {
  const appView = useLayoutStore((s) => s.appView)
  const setAppView = useLayoutStore((s) => s.setAppView)
  const baseBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    padding: '3px 10px',
    fontSize: '11px',
    fontWeight: 500,
    cursor: 'pointer',
    color: 'var(--text-muted)',
    borderRadius: '4px',
    WebkitAppRegion: 'no-drag',
    transition: 'background 0.12s, color 0.12s',
  }
  const activeBtn: React.CSSProperties = {
    ...baseBtn,
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '2px',
        gap: '2px',
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      }}
      title="Toggle Chats ↔ Board (⌘⇧K)"
    >
      <button
        type="button"
        style={appView === 'chats' ? activeBtn : baseBtn}
        onClick={() => setAppView('chats')}
      >
        Chats
      </button>
      <button
        type="button"
        style={appView === 'kanban' ? activeBtn : baseBtn}
        onClick={() => setAppView('kanban')}
      >
        Board
      </button>
    </span>
  )
}

function ChatWorkspacePanels({
  dataScienceMode,
  onOpenBeside,
}: {
  dataScienceMode: boolean
  onOpenBeside: () => void
}) {
  const chatSplitRatio = useLayoutStore((s) => s.chatSplitRatio)
  const setChatSplitRatio = useLayoutStore((s) => s.setChatSplitRatio)
  const primarySessionId = useLayoutStore((s) => s.primarySessionId)
  const secondarySessionId = useLayoutStore((s) => s.secondarySessionId)
  const focusedSlot = useLayoutStore((s) => s.focusedChatSlot)
  const focusChatSlot = useLayoutStore((s) => s.focusChatSlot)
  const closeChatSlot = useLayoutStore((s) => s.closeChatSlot)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(1000)
  const [splitDragging, setSplitDragging] = useState(false)
  const [chatPresentation, setChatPresentation] = useState<ChatPresentation>(
    dataScienceMode ? 'tabs' : 'split',
  )
  const primaryLabel = useAgentStore((state) =>
    state.sessions.find((session) => session.id === primarySessionId)?.title ?? 'Primary chat',
  )
  const secondaryLabel = useAgentStore((state) =>
    state.sessions.find((session) => session.id === secondarySessionId)?.title ?? 'Secondary chat',
  )

  useEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setWorkspaceWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setChatPresentation((current) =>
      nextChatPresentation(current, workspaceWidth, dataScienceMode, splitDragging),
    )
  }, [workspaceWidth, dataScienceMode, splitDragging])

  const dual = secondarySessionId !== null
  const tabbed = dual && chatPresentation === 'tabs'
  const showFocusIndicator = shouldShowChatFocusIndicator(dual, chatPresentation)

  return (
    <div
      ref={workspaceRef}
      data-chat-workspace
      data-chat-presentation={chatPresentation}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      {tabbed && (
        <div className="chat-workspace-tabs" role="tablist" aria-label="Chats side by side">
          <button
            type="button"
            role="tab"
            aria-selected={focusedSlot === 'primary'}
            onClick={() => focusChatSlot('primary')}
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={focusedSlot === 'secondary'}
            onClick={() => focusChatSlot('secondary')}
          >
            {secondaryLabel}
          </button>
        </div>
      )}
      <div style={{ flex: '1 1 0%', minHeight: 0, minWidth: 0, display: 'flex' }}>
      <div
        ref={leftRef}
        data-chat-slot-wrapper="primary"
        style={{
          flex: dual && !tabbed ? `${chatSplitRatio} 1 0%` : '1 1 0%',
          display: tabbed && focusedSlot !== 'primary' ? 'none' : 'flex',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <ChatPanel
          chatSlot="primary"
          visible={!tabbed || focusedSlot === 'primary'}
          showFocusIndicator={showFocusIndicator}
          onClose={dual ? () => closeChatSlot('primary') : undefined}
          onOpenBeside={onOpenBeside}
        />
      </div>
      {dual && !tabbed && (
        <ChatSplitHandle
          leftRef={leftRef}
          rightRef={rightRef}
          initialRatio={chatSplitRatio}
          onCommit={setChatSplitRatio}
          onDraggingChange={setSplitDragging}
        />
      )}
      <div
        ref={rightRef}
        data-chat-slot-wrapper="secondary"
        style={{
          flex: !tabbed ? `${1 - chatSplitRatio} 1 0%` : '1 1 0%',
          display: !dual || (tabbed && focusedSlot !== 'secondary') ? 'none' : 'flex',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <ChatPanel
          chatSlot="secondary"
          visible={dual && (!tabbed || focusedSlot === 'secondary')}
          showFocusIndicator={showFocusIndicator}
          onClose={() => closeChatSlot('secondary')}
          onOpenBeside={onOpenBeside}
        />
      </div>
      </div>
    </div>
  )
}

/**
 * Drag handle between two ChatPanels. Writes flex-grow directly to the
 * two panel DOM nodes during drag (no React re-renders). Commits the
 * final ratio to the store on pointerup.
 */
function ChatSplitHandle({
  leftRef,
  rightRef,
  initialRatio,
  onCommit,
  onDraggingChange,
}: {
  leftRef: React.RefObject<HTMLDivElement | null>
  rightRef: React.RefObject<HTMLDivElement | null>
  initialRatio: number
  onCommit: (ratio: number) => void
  onDraggingChange?: (dragging: boolean) => void
}) {
  const activePointerRef = useRef<number | null>(null)
  const currentRatioRef = useRef(initialRatio)
  const handleElRef = useRef<HTMLDivElement | null>(null)

  // Single idempotent teardown so the divider can never get stuck in resize
  // mode. Called from pointerup, pointercancel, lostpointercapture (pointer
  // crossed into a ChatPanel webview and capture was yanked), and window blur.
  const endDrag = useCallback(() => {
    if (activePointerRef.current === null) return
    const el = handleElRef.current
    if (el) { try { el.releasePointerCapture(activePointerRef.current) } catch { /* ignore */ } }
    activePointerRef.current = null
    onDraggingChange?.(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    hideDragOverlay()
    onCommit(currentRatioRef.current)
  }, [onCommit, onDraggingChange])

  useEffect(() => {
    const onBlur = () => endDrag()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      // Unmounted mid-drag: clear the stuck cursor / overlay.
      if (activePointerRef.current !== null) {
        activePointerRef.current = null
        onDraggingChange?.(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        hideDragOverlay()
      }
    }
  }, [endDrag, onDraggingChange])

  return (
    <div
      ref={handleElRef}
      style={{
        width: '4px',
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'var(--border)',
        position: 'relative',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
        activePointerRef.current = e.pointerId
        onDraggingChange?.(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        showDragOverlay('col-resize')
      }}
      onPointerMove={(e) => {
        if (activePointerRef.current !== e.pointerId) return
        const row = (e.currentTarget as HTMLElement).parentElement
        if (!row) return
        const rect = row.getBoundingClientRect()
        const local = e.clientX - rect.left
        const ratio = Math.max(0.2, Math.min(0.8, local / rect.width))
        currentRatioRef.current = ratio
        // Direct DOM writes - no React re-render during drag.
        if (leftRef.current) leftRef.current.style.flex = `${ratio} 1 0%`
        if (rightRef.current) rightRef.current.style.flex = `${1 - ratio} 1 0%`
      }}
      onPointerUp={() => endDrag()}
      onPointerCancel={() => endDrag()}
      onLostPointerCapture={() => endDrag()}
    />
  )
}
