import { useEffect, useRef, useCallback, useState } from 'react'
import { useLayoutStore, hydrateSidebarCollapse, paneMaxWidth } from './stores/layout-store'
import { useAgentStore, setStoreDefaultRuntimeMode, type RuntimeMode } from './stores/agent-store'
import { classifyCloseFocus, type ClosestEl } from './close-focus'
import { useBookmarkStore } from './stores/bookmark-store'
import { useThemeStore } from './stores/theme-store'
import { useTerminalStore } from './stores/terminal-store'
import { useMachineStore } from './stores/machine-store'
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle'
import { ResizeHandle } from './components/layout/ResizeHandle'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatWorkspacePanels } from './components/chat/ChatWorkspacePanels'
import { ViewToggle } from './components/layout/ViewToggle'
import { TerminalSessionPane } from './components/terminal/TerminalSessionPane'
import { TerminalStrip } from './components/terminal/TerminalStrip'
import { IdePane } from './components/ide/IdePane'
import { KanbanView } from './components/kanban/KanbanView'
import { SettingsPage } from './components/SettingsPage'
import type { SettingsPageId } from './components/settings/settings-rows'
import { CommandPalette } from './components/CommandPalette'
import { NewChatProjectPicker } from './components/NewChatProjectPicker'
import { SearchModal } from './components/SearchModal'
import { StatusBar } from './components/StatusBar'
import { SessionPickerModal } from './components/SessionPickerModal'
import { QuickPromptModal } from './components/QuickPromptModal'
import { FeatureTourModal } from './components/onboarding/FeatureTourModal'
import { UpdateToast } from './components/UpdateToast'
import { AnalyticsNotice } from './components/AnalyticsNotice'
import { ConfirmHost, unlessConfirmOpen } from './components/ui/confirm'
import { TOUR_VERSION, type TryItAction } from './components/onboarding/feature-registry'
import { appendIdeSelectionToDraft, appendTerminalSelectionToDraft, captureSelection, formatIdeSelection } from './services/context-bridge'
import { focusTerminal, destroyTerminal } from './services/terminal-registry'
import { sessionExecutionRootPath } from './services/execution-root'
import { emitSessionCreated, onProviderEvent, onSessionRename } from './services/session-events'
import { initSharedReadState } from './services/read-state'
import { getDefaultSessionEnvMode } from './services/session-env-mode'
import {
  createDesktopNewChatCoordinator,
  retainedWorktreeCreationKey,
  retryDesktopWorktreeCreation,
  shouldDismissDesktopWorktreeSnapshot,
  type DesktopNewChatCoordinator,
  type DesktopNewChatState,
} from './services/desktop-new-chat-creation'
import { createDesktopNewChatJournal } from './services/desktop-new-chat-journal'
import { WorktreeCreationProgress } from './components/worktree/WorktreeCreationProgress'
import type { WorktreeCreationRecoveryAction, WorktreeCreationSnapshot } from '@shared/worktree-creation'
import { draftSessionId } from '@shared/new-chat-draft'
import { parkFirstSend, peekFirstSend, setDraftMaterializer, takeFirstSend } from './services/draft-chat'
import { toAgentProvider, type SessionSummary, type ChatMessage } from '@shared/types'
import { SETTING_DEFAULT_RUNTIME_MODE, isRuntimeMode } from '@shared/session-defaults'
import { needsMessageReload, resolveSessionDisplayTitle, resolveSessionOpenAgentType, resolveSessionResumeId, resolveSessionSelectTarget, shouldEvictMessages, shouldRetrySessionLoadAfterCreate } from './utils/session-eviction'
import { createRendererLogger } from './logger'
import { focusComposer } from './services/composer-registry'
import { useDraftStore } from './stores/draft-store'
import { nextDualChatShortcutAction, shouldEvictReplacedSession } from './services/chat-workspace'
import type { AgentProvider } from '@shared/types'
import { recoverPendingRequests } from './services/pending-request-recovery'
import { resolveGlobalKeydown } from './services/global-keybindings'

const log = createRendererLogger('app')

function toggleDualChatWorkspace(openPicker: () => void): void {
  const layout = useLayoutStore.getState()
  if (nextDualChatShortcutAction(layout) === 'close-secondary') {
    layout.closeChatSlot('secondary')
  } else {
    openPicker()
  }
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
  const materializingDrafts = useRef(new Set<string>())
  const newChatJournal = useRef(createDesktopNewChatJournal(window.localStorage))
  const [worktreeCreationSnapshots, setWorktreeCreationSnapshots] = useState<Record<string, WorktreeCreationSnapshot>>({})

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
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null)
  const settingsOpen = settingsPage !== null
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [newChatPickerOpen, setNewChatPickerOpen] = useState(false)
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
      } catch (err) {
        log.debug('tour auto-open settings unavailable - skipping', err)
      }
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
      setSettingsPage(action.page)
    }
  }, [])

  // Listen for an explicit "replay tour" event so the Settings page (which
  // doesn't own this state) can trigger the modal without prop-drilling.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ startAt?: number }>).detail
      setTourStartAt(detail?.startAt ?? 0)
      setSettingsPage(null)
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

  // Open approval/question/plan cards per thread, for the sidebar's "Needs
  // you", and queued messages. Here rather than in ChatPanel: it must see
  // events for chats no panel shows.
  useEffect(() => {
    if (!window.api.provider?.onEvent) return
    return onProviderEvent((event) => {
      const store = useAgentStore.getState()
      store.trackPendingRequestEvent(event)
      store.trackQueuedTurnEvent(event)
    })
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
        if (isRuntimeMode(stored)) {
          setStoreDefaultRuntimeMode(stored)
        }
      } catch (err) {
        log.debug('default runtime mode settings unavailable in tests / first boot', err)
      }
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
        if (live?.length) {
          useAgentStore.getState().adoptLiveSessions(live)
          for (const session of live) void recoverPendingRequests(session.threadId, { cards: false })
        }
      } catch (err) {
        log.warn('could not adopt running backend sessions', err)
      }
    })()
  }, [loadSavedTheme])

  // A remote (or the hybrid base) backend could not replay everything a
  // window missed - the live event that opened an approval/question/plan
  // card is gone for good. Recover it for whatever is actually on screen;
  // `machineId === null` means the base backend, so every displayed thread
  // is a candidate rather than trying to filter by one.
  useEffect(() => {
    return window.api.routing?.onResumeGap?.((machineId) => {
      const displayed = new Set(useLayoutStore.getState().displayedChatSessionIds())
      // Every chat, not only the displayed ones: the sidebar's "Needs you"
      // reads them all. Cards are appended only where a chat is on screen.
      for (const session of useAgentStore.getState().sessions) {
        if (session.type === 'terminal') continue
        if (machineId !== null && session.machineId !== machineId) continue
        void recoverPendingRequests(session.id, { cards: displayed.has(session.id) })
      }
    })
  }, [])

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
    const remove = window.api.onOpenSettings(unlessConfirmOpen(() => {
      setSettingsPage('general')
    }))
    return () => { remove() }
  }, [])

  useEffect(() => {
    if (typeof window.api?.onOpenChatBeside !== 'function') return
    return window.api.onOpenChatBeside(unlessConfirmOpen(() => toggleDualChatWorkspace(() => setSessionPickerOpen(true))))
  }, [])

  // ⌘W  close active TAB (close window when last tab)
  // ⌘⇧W close entire active WINDOW (all tabs)
  // No active window → close the app window.
  useEffect(() => {
    if (typeof window.api?.onClosePaneOrWindow !== 'function') return
    const remove = window.api.onClosePaneOrWindow(unlessConfirmOpen((opts: { shift?: boolean }) => {
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
    }))
    return () => { remove() }
  }, [])

  // "+ New Chat" submits one backend-owned creation intent. Worktree mode
  // never falls through to the parent checkout: that is a separate recovery
  // action the user must choose explicitly.
  const publishAuthoritativeSession = useCallback((session: {
    id: string
    type: AgentProvider
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
    // A draft's first send created this conversation: hand its message and its
    // picker choices to the real session before the pane mounts it.
    const parkedDraftId = peekFirstSend(session.id)?.draftId
    if (parkedDraftId) materializingDrafts.current.delete(parkedDraftId)
    const draft = parkedDraftId
      ? useAgentStore.getState().sessions.find((s) => s.id === parkedDraftId)
      : undefined
    if (session.managedTerminalIds?.length && session.worktreePath) {
      useTerminalStore.getState().adoptManagedTerminals(
        session.id,
        session.managedTerminalIds,
        session.worktreePath,
      )
    }
    addSession({
      ...session,
      ...(draft?.model ? { model: draft.model } : {}),
      ...(draft?.instanceId ? { instanceId: draft.instanceId } : {}),
      ...(draft?.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    })
    if (draft?.model) window.api.app.setConversationModel?.(session.id, draft.model).catch((err: unknown) => log.warn('carry draft model failed', err))
    if (draft?.instanceId) window.api.app.setConversationProviderInstanceId(session.id, draft.instanceId).catch((err: unknown) => log.warn('carry draft instance failed', err))
    if (draft?.reasoningEffort) window.api.app.setConversationReasoningEffort(session.id, draft.reasoningEffort).catch((err: unknown) => log.warn('carry draft effort failed', err))
    if (draft) window.api.app.setConversationRuntimeMode?.(session.id, session.runtimeMode).catch((err: unknown) => log.warn('persist runtime mode failed', err))
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

  const makeNewChatCoordinator = useCallback((onState?: (state: DesktopNewChatState) => void) => createDesktopNewChatCoordinator({
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
          ...(intent.existingWorktree
            ? { worktreePath: intent.existingWorktree.path, worktreeBranch: intent.existingWorktree.branch }
            : {}),
        })
        publishAuthoritativeSession({
          id: intent.conversationId,
          type: intent.agentType,
          status: 'idle',
          projectPath: intent.projectPath,
          machineId: intent.machineId,
          title: intent.title,
          runtimeMode: intent.runtimeMode,
          ...(intent.existingWorktree
            ? { worktreePath: intent.existingWorktree.path, worktreeBranch: intent.existingWorktree.branch }
            : {}),
        })
        return { conversationId: intent.conversationId }
      },
    },
    journal: newChatJournal.current,
    createId: () => crypto.randomUUID(),
    now: Date.now,
    onStateChange: (state) => {
      onState?.(state)
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

  // "+ New Chat" and cmd+shift+O open a draft. Nothing is created until the
  // first send, so an abandoned click leaves no conversation row and no worktree.
  const openDraftChat = useCallback(async (projectPath: string, machineId: string = 'local') => {
    useLayoutStore.getState().setAppView('chats')
    const id = draftSessionId(machineId, projectPath)
    const store = useAgentStore.getState()
    if (!store.sessions.some((s) => s.id === id)) {
      // Carry the picks of the focused chat (the secondary pane in dual chat);
      // the store default covers the rest.
      const focusedId = useLayoutStore.getState().focusedChatSessionId()
      const from = store.sessions.find((s) => s.id === focusedId)
      const carry = from && !from.draft && from.type !== 'terminal' ? from : undefined
      const envMode = await getDefaultSessionEnvMode()
      // A second open for the same project can land during the await.
      if (useAgentStore.getState().sessions.some((s) => s.id === id)) { selectChatSession(id); return }
      window.api.routing.bind(id, machineId)
      store.addSession({
        id,
        type: carry?.type ?? 'claude-code',
        status: 'idle',
        projectPath,
        machineId,
        title: 'New chat',
        runtimeMode: carry?.runtimeMode,
        ...(carry?.model ? { model: carry.model } : {}),
        ...(carry?.instanceId ? { instanceId: carry.instanceId } : {}),
        ...(carry?.reasoningEffort ? { reasoningEffort: carry.reasoningEffort } : {}),
        draft: { checkout: envMode === 'worktree' ? 'worktree' : 'project', baseRef: 'HEAD' },
      })
    }
    selectChatSession(id)
  }, [selectChatSession])

  const retainCoordinator = useCallback((coordinator: DesktopNewChatCoordinator, checkout: 'project' | 'worktree') => {
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
  }, [])

  useEffect(() => {
    setDraftMaterializer(async (draftId, send) => {
      // One creation per draft. A remounted composer has a fresh submit
      // guard, so this is the one that holds across panes and view switches.
      if (materializingDrafts.current.has(draftId)) {
        return { accepted: false, error: 'This chat is already being created.' }
      }
      const draft = useAgentStore.getState().sessions.find((s) => s.id === draftId)
      if (!draft?.draft || !draft.projectPath || draft.type === 'terminal') {
        return { accepted: false, error: 'This draft is no longer available.' }
      }
      const checkout = draft.draft.checkout
      const conversationId = crypto.randomUUID()
      materializingDrafts.current.add(draftId)
      let insideStart = true
      let gaveBack = false
      // A creation that ends without a conversation (failed, or a worktree
      // left needing cleanup) returns the draft. Inside start() the composer
      // restores the full payload from accepted: false; after it, a late
      // failure can only put the text back.
      const giveBack = () => {
        const parked = takeFirstSend(conversationId)
        if (!parked) return
        gaveBack = true
        materializingDrafts.current.delete(draftId)
        useAgentStore.getState().updateStatus(draftId, 'idle')
        if (!insideStart && !useDraftStore.getState().getDraft(draftId)) {
          useDraftStore.getState().setDraft(draftId, parked.message)
        }
      }
      const coordinator = makeNewChatCoordinator((state) => {
        const snapshot = state.snapshot
        if (state.status === 'failed' || (snapshot && snapshot.status !== 'ready' && (
          snapshot.status === 'failed' || snapshot.status === 'cleanup_required' || shouldDismissDesktopWorktreeSnapshot(snapshot)
        ))) giveBack()
      })
      parkFirstSend(conversationId, { ...send, draftId })
      useAgentStore.getState().updateStatus(draftId, 'running')
      let state: DesktopNewChatState
      let startError: unknown
      try {
        if (checkout === 'existing') {
          const picked = draft.draft.existing
          if (!picked) throw new Error('Pick the worktree this chat should run in.')
          // It may have been removed since the chip listed it.
          const refs = await window.api.git.listRefs(draft.projectPath)
          if (!refs.ok) throw new Error('Could not check the worktree. Try again.')
          if (!refs.refs.some((r) => r.worktreePath === picked.path && r.name === picked.branch)) {
            throw new Error(`The worktree for ${picked.branch} no longer exists or changed branch. Pick it again.`)
          }
        }
        state = await coordinator.start({
          projectPath: draft.projectPath,
          machineId: draft.machineId ?? 'local',
          checkout: checkout === 'worktree' ? 'worktree' : 'project',
          ...(checkout === 'existing' && draft.draft.existing ? { existingWorktree: draft.draft.existing } : {}),
          agentType: draft.type,
          runtimeMode: draft.runtimeMode,
          baseRef: draft.draft.baseRef,
          conversationId,
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.instanceId ? { instanceId: draft.instanceId } : {}),
        })
      } catch (error) {
        startError = error
        state = coordinator.state()
      }
      const failed = Boolean(startError) || gaveBack || state.status === 'failed'
      // Still inside start: the composer, not giveBack, restores the payload.
      if (failed) giveBack()
      insideStart = false
      retainCoordinator(coordinator, checkout === 'worktree' ? 'worktree' : 'project')
      if (failed) {
        const message = startError instanceof Error ? startError.message : state.error
        return { accepted: false, error: message ?? 'The new chat could not be created. See the worktree card for recovery.' }
      }
      return { accepted: true }
    })
    return () => setDraftMaterializer(null)
  }, [makeNewChatCoordinator, retainCoordinator])

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
        // Thread (re)open: recover any approval/question/plan card a resume
        // gap or a reload dropped. Cards are never persisted to history, so
        // this runs whether or not the reload above ran.
        if (session.agentType !== 'terminal') void recoverPendingRequests(session.id)
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
          executionRootRevision?: number
          worktreeId?: string | null
          providerInstanceId?: string | null
          runtimeMode?: RuntimeMode | null
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
        // A session adopted at startup was created without a revision, and
        // this branch returns before the hydration below. Leaving it at 0
        // makes the next Follow fail as stale on any conversation that has
        // been relocated before. The setter only ever raises it.
        if (loaded?.meta?.executionRootRevision) {
          useAgentStore.getState().syncExecutionRootRevision(targetId, loaded.meta.executionRootRevision)
        }
        placeAndEvict(targetId)
        void recoverPendingRequests(targetId)
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
        type: resolveSessionOpenAgentType(toAgentProvider(session.source), loaded?.meta?.agentType),
        status: 'idle',
        projectPath: loaded?.meta?.projectPath ?? projectPath,
        machineId: effectiveMachineId,
        worktreeId: loaded?.meta?.worktreeId ?? creationSnapshot?.worktreeId ?? null,
        worktreePath: loaded?.meta?.worktreePath ?? session.worktreePath ?? null,
        worktreeBranch: loaded?.meta?.worktreeBranch ?? session.worktreeBranch ?? null,
        executionRootRevision: loaded?.meta?.executionRootRevision ?? 0,
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
        agentType: toAgentProvider(session.source),
        title: session.title,
      }).catch((err) => {
        log.debug(`createConversation failed for ${session.id} - row may already exist`, err)
      })

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
        if (isRuntimeMode(persisted)) {
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
      void recoverPendingRequests(session.id)
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
    void recoverPendingRequests(sessionId)
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
      const action = resolveGlobalKeydown(e)
      if (!action) return
      switch (action.type) {
        case 'toggle-sidebar':
          e.preventDefault()
          toggleSidebar()
          break
        case 'toggle-data-science':
          e.preventDefault()
          useLayoutStore.getState().toggleDataScienceMode()
          if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
          break
        case 'toggle-terminal':
          e.preventDefault()
          toggleTerminal()
          break
        case 'toggle-right-pane': {
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
          break
        }
        case 'toggle-app-view':
          e.preventDefault()
          useLayoutStore.getState().toggleAppView()
          break
        case 'new-chat':
          e.preventDefault()
          setNewChatPickerOpen(true)
          break
        case 'toggle-palette':
          e.preventDefault()
          setPaletteOpen((prev) => !prev)
          break
        case 'toggle-search':
          e.preventDefault()
          setSearchOpen((prev) => !prev)
          break
        // Previously: silently did nothing when `activeSessionId` was
        // null - a bad UX that made the shortcut feel broken. Now:
        // falls back to the first available session; if none exist,
        // logs a helpful console warning so devtools shows the reason.
        case 'new-terminal-window': {
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
          const cwd = sessionExecutionRootPath(sid)
          const ref = ids.length === 0
            ? st.addWindow(sid, { label, cwd })
            : st.splitActiveWindow(sid, action.direction, { label, cwd })
          if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
          if (ref) setTimeout(() => focusTerminal(ref.paneId), 80)
          break
        }
        // Opens the most-recent other session on the right, or closes if already dual.
        case 'toggle-dual-chat':
          e.preventDefault()
          toggleDualChatWorkspace(() => setSessionPickerOpen(true))
          break
        // xterm's helper textarea counts as text input so ⌘+Delete keeps its
        // line-kill behavior.
        case 'interrupt': {
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
              window.api.provider?.interrupt?.(sid).catch((err) => {
                log.debug(`keyboard-shortcut interrupt failed for ${sid}`, err)
              })
            }
          }
          break
        }
        // User types their question after the pasted context and hits Send as normal.
        case 'context-bridge': {
          e.preventDefault()
          // Routes by `data-context-source` on the selection's anchor:
          // terminal | file-viewer | chat-message. Falls back to legacy
          // terminal-only flow when nothing is wired up.
          const appended = captureSelection()
          if (!appended) {
            log.info('⌘L: no selection - select text in a terminal, file viewer, or chat message first')
          }
          break
        }
        // Pre-fills with the current terminal selection as context (if any).
        case 'quick-prompt':
          e.preventDefault()
          setQuickPromptOpen(true)
          break
        case 'new-terminal-tab': {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            e.preventDefault()
            const st = useTerminalStore.getState()
            const ids = st.getAllPaneIds(sid)
            const cwd = sessionExecutionRootPath(sid)
            const pid = st.addPaneToActiveWindow(sid, { label: `Terminal ${ids.length + 1}`, cwd })
            if (!useLayoutStore.getState().terminalVisible) toggleTerminal()
            if (pid) setTimeout(() => focusTerminal(pid), 80)
          }
          break
        }
        case 'cycle-tab': {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            e.preventDefault()
            useTerminalStore.getState().cyclePane(sid, action.direction)
            const pid = useTerminalStore.getState().getActivePaneId(sid)
            if (pid) setTimeout(() => focusTerminal(pid), 40)
          }
          break
        }
        case 'focus-direction': {
          const sid = useLayoutStore.getState().companionSessionId()
          if (!sid) return
          e.preventDefault()
          useTerminalStore.getState().focusDirection(sid, action.direction)
          const pid = useTerminalStore.getState().getActivePaneId(sid)
          if (pid) setTimeout(() => focusTerminal(pid), 40)
          break
        }
        case 'focus-window': {
          const sid = useLayoutStore.getState().companionSessionId()
          if (sid) {
            const ids = useTerminalStore.getState().getAllWindowIds(sid)
            if (action.index < ids.length) {
              e.preventDefault()
              useTerminalStore.getState().focusWindowByIndex(sid, action.index)
              const pid = useTerminalStore.getState().getActivePaneId(sid)
              if (pid) setTimeout(() => focusTerminal(pid), 50)
            }
          }
          break
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
            onClick={() => setSettingsPage('general')}
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
          data-testid="app-sidebar"
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
            onNewChat={openDraftChat}
            onPickNewChat={() => setNewChatPickerOpen(true)}
            onSessionSelect={handleSessionSelect}
            onOpenBeside={(session, projectPath, machineId) => {
              void handleSessionSelect(session, projectPath, machineId, 'beside')
            }}
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

      <SettingsPage page={settingsPage} onNavigate={setSettingsPage} onClose={() => setSettingsPage(null)} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NewChatProjectPicker
        open={newChatPickerOpen}
        current={(() => {
          const focusedId = useLayoutStore.getState().focusedChatSessionId()
          const focused = useAgentStore.getState().sessions.find((s) => s.id === focusedId)
          return focused ? { projectPath: focused.projectPath, machineId: focused.machineId } : undefined
        })()}
        onPick={(projectPath, machineId) => { setNewChatPickerOpen(false); void openDraftChat(projectPath, machineId) }}
        onClose={() => setNewChatPickerOpen(false)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => { setPaletteOpen(false); setSettingsPage('general') }}
        onOpenSearch={() => { setPaletteOpen(false); setSearchOpen(true) }}
        onOpenSessionPicker={() => { setPaletteOpen(false); setSessionPickerOpen(true) }}
        onOpenQuickPrompt={() => { setPaletteOpen(false); setQuickPromptOpen(true) }}
        onContextBridge={() => { setPaletteOpen(false); appendTerminalSelectionToDraft() }}
        onNewChat={openDraftChat}
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
      <AnalyticsNotice />
      <ConfirmHost />
    </div>
  )
}
