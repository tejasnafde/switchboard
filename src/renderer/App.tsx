import { useEffect, useRef, useCallback, useState } from 'react'
import { useLayoutStore, hydrateSidebarCollapse } from './stores/layout-store'
import { useAgentStore } from './stores/agent-store'
import { useThemeStore } from './stores/theme-store'
import { useTerminalStore } from './stores/terminal-store'
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle'
import { ResizeHandle } from './components/layout/ResizeHandle'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatPanel } from './components/chat/ChatPanel'
import { TerminalStrip } from './components/terminal/TerminalStrip'
import { SettingsModal } from './components/SettingsModal'
import { CommandPalette } from './components/CommandPalette'
import { SearchModal } from './components/SearchModal'
import { StatusBar } from './components/StatusBar'
import { SessionPickerModal } from './components/SessionPickerModal'
import { QuickPromptModal } from './components/QuickPromptModal'
import { FeatureTourModal } from './components/onboarding/FeatureTourModal'
import { TOUR_VERSION, type TryItAction } from './components/onboarding/featureRegistry'
import { appendTerminalSelectionToDraft } from './services/contextBridge'
import { focusTerminal, destroyTerminal } from './services/terminal-registry'
import { emitSessionCreated } from './services/session-events'
import type { SessionSummary, ChatMessage } from '@shared/types'

/**
 * Root layout — flat flex row, no nesting.
 * All panels always mounted. Toggles use visibility:hidden + width:0.
 * Resize handles manipulate DOM directly during drag.
 */
export function App() {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<HTMLDivElement>(null)

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
    dualChat,
    rightSessionId,
    chatSplitRatio,
    openRightPanel,
    closeRightPanel,
  } = useLayoutStore()

  const { addSession, setActiveSession, setMessages } = useAgentStore()
  const { loadSavedTheme } = useThemeStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [quickPromptOpen, setQuickPromptOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [tourStartAt, setTourStartAt] = useState(0)

  // First-run / what's-new gating: open the tour automatically when
  // `tour.lastSeenVersion` is missing or older than TOUR_VERSION, unless
  // the user has switched off `tour.autoplay`. Settings tab provides a
  // manual replay path either way.
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
      } catch { /* settings unavailable — silently skip auto-open */ }
    })()
    return () => { cancelled = true }
  }, [])

  const handleTryIt = useCallback((action: TryItAction) => {
    if (action.kind === 'focus-chat-with-slash') {
      // Focus the chat input and pre-type "/". ChatInput owns its own
      // textarea ref via querySelector — keep this loose to avoid a new
      // global event bus just for the tour.
      setTimeout(() => {
        const ta = document.querySelector<HTMLTextAreaElement>('[data-chat-input-textarea]')
        if (ta) {
          ta.focus()
          ta.value = '/'
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        }
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

  // Load saved theme on mount
  useEffect(() => {
    loadSavedTheme()
    void hydrateSidebarCollapse()
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

  // Intercept external link clicks — open in default browser
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

  // Listen for settings shortcut from native menu
  useEffect(() => {
    if (typeof window.api?.onOpenSettings !== 'function') return
    const remove = window.api.onOpenSettings(() => {
      setSettingsOpen(true)
    })
    return () => { remove() }
  }, [])

  // ⌘W  close active TAB (close window when last tab)
  // ⌘⇧W close entire active WINDOW (all tabs)
  // No active window → close the app window.
  useEffect(() => {
    if (typeof window.api?.onClosePaneOrWindow !== 'function') return
    const remove = window.api.onClosePaneOrWindow((opts: { shift?: boolean }) => {
      // If focus is inside a chat panel and dual-chat mode is on, ⌘W
      // closes that specific panel. This takes priority over terminal
      // close so the shortcut feels natural when the chat has focus.
      const active = document.activeElement
      const focusedPanel = active instanceof HTMLElement
        ? active.closest('[data-chat-panel]') as HTMLElement | null
        : null
      const layoutState = useLayoutStore.getState()
      if (focusedPanel && layoutState.dualChat) {
        const which = focusedPanel.getAttribute('data-chat-panel')
        if (which === 'right') {
          layoutState.closeRightPanel()
          return
        }
        if (which === 'left') {
          layoutState.closeLeftPanel(useAgentStore.getState().setActiveSession)
          return
        }
      }

      const sid = useAgentStore.getState().activeSessionId
      if (sid) {
        const layout = useTerminalStore.getState().getLayout(sid)
        const wid = layout.activeWindowId
        const win = wid ? layout.windows[wid] : null
        if (win) {
          if (opts.shift) {
            // ⌘⇧W — close the whole window and its tabs
            for (const pid of win.paneIds) destroyTerminal(pid)
            useTerminalStore.getState().removeWindow(sid, wid!)
          } else {
            // ⌘W — close just the active tab (window closes itself if last tab)
            const activePaneId = win.activePaneId
            if (activePaneId) {
              destroyTerminal(activePaneId)
              useTerminalStore.getState().removePane(sid, activePaneId)
            }
          }
          return
        }
      }
      // No active window — close the app window
      window.api.closeWindow?.()
    })
    return () => { remove() }
  }, [])

  // "+ New Chat" — create a fresh session tied to a project
  const handleNewChat = useCallback(
    (projectPath: string) => {
      const id = `agent_${Date.now()}`
      const title = 'New conversation'
      addSession({
        id,
        type: 'claude-code',
        status: 'idle',
        projectPath,
        title,
      })
      setActiveSession(id)

      // Persist to DB (best-effort)
      window.api.app.createConversation({
        id,
        projectPath,
        agentType: 'claude-code',
        title,
      }).catch(() => {})

      // Notify sidebar so it shows this new chat immediately
      emitSessionCreated({
        id,
        projectPath,
        title,
        startedAt: Date.now(),
        source: 'switchboard',
      })
    },
    [addSession, setActiveSession],
  )

  // Click a session in sidebar — load its messages from disk
  const handleSessionSelect = useCallback(
    async (session: SessionSummary, projectPath: string) => {
      // Check if session already loaded in store
      const existing = useAgentStore.getState().sessions.find((s) => s.id === session.id)
      if (existing) {
        setActiveSession(session.id)
        return
      }

      // Create session in store — pass session.id as resumeSessionId
      // so Claude CLI can --resume the conversation
      addSession({
        id: session.id,
        type: (session.source === 'codex' ? 'codex' : 'claude-code'),
        status: 'idle',
        projectPath,
        resumeSessionId: session.id,
        title: session.title,
      })
      setActiveSession(session.id)

      // Ensure conversation row exists in DB so subsequent saveMessage /
      // bulkSaveMessages calls don't skip due to missing FK.
      await window.api.app.createConversation({
        id: session.id,
        projectPath,
        agentType: (session.source === 'codex' ? 'codex' : 'claude-code'),
        title: session.title,
      }).catch(() => {})

      // Load messages from JSONL file
      if (session.filePath) {
        try {
          const messages: ChatMessage[] = await window.api.app.loadSession(
            session.filePath,
            session.id,
            session.source === 'codex' ? 'codex' : 'claude-code',
          )
          if (messages.length > 0) {
            setMessages(session.id, messages)
          }
        } catch {
          // Failed to load — session will show empty state
        }
      }
    },
    [addSession, setActiveSession, setMessages],
  )

  useEffect(() => {
    registerSidebarEl(sidebarRef.current)
    registerTerminalEl(terminalRef.current)
  }, [registerSidebarEl, registerTerminalEl])

  // Sync terminal store's activeSession with agent store
  const activeAgentSessionId = useAgentStore((s) => s.activeSessionId)
  const termSetActiveSession = useTerminalStore((s) => s.setActiveSession)

  useEffect(() => {
    termSetActiveSession(activeAgentSessionId)
  }, [activeAgentSessionId, termSetActiveSession])

  // Terminal lifecycle — spawn/kill PTYs on session change
  useTerminalLifecycle()

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault()
          toggleSidebar()
        } else if (e.key === 'j' || e.key === 'J') {
          e.preventDefault()
          toggleTerminal()
        }
        // ⌘+Shift+P — command palette
        else if ((e.key === 'p' || e.key === 'P') && e.shiftKey) {
          e.preventDefault()
          setPaletteOpen((prev) => !prev)
        }
        // ⌘+Shift+F — search across conversations
        else if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
          e.preventDefault()
          setSearchOpen((prev) => !prev)
        }
        // ⌘+⇧+T — new window in a new row (below)
        // ⌘+T    — new window in the same row (right of active)
        //
        // Previously: silently did nothing when `activeSessionId` was
        // null — a bad UX that made the shortcut feel broken. Now:
        // falls back to the first available session; if none exist,
        // logs a helpful console warning so devtools shows the reason.
        else if (e.key.toLowerCase() === 't') {
          e.preventDefault()
          const agentState = useAgentStore.getState()
          let sid = agentState.activeSessionId
          if (!sid) {
            // Fallback — pick the most recent session so ⌘T still works
            // even if the user hasn't explicitly focused a chat.
            sid = agentState.sessions[0]?.id ?? null
            if (sid) agentState.setActiveSession(sid)
          }
          if (!sid) {
            // eslint-disable-next-line no-console
            console.warn('[Switchboard] ⌘T pressed but no session available. Open or create a chat first.')
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
        // ⌘+Shift+| — toggle dual-chat mode (opens rightmost inactive
        // session on the right, or closes if already dual). When opening,
        // pick the most-recent session that isn't the currently active one.
        //
        // Guard: skip when the user is typing in a text input / textarea /
        // contenteditable — otherwise this shortcut eats characters and
        // wipes in-progress drafts with attachments.
        else if (e.key === '|' || (e.key === '\\' && e.shiftKey)) {
          const active = document.activeElement
          const inXterm = active instanceof HTMLElement && active.classList.contains('xterm-helper-textarea')
          const inText = !inXterm && active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
          const inContentEditable = active instanceof HTMLElement && active.closest('[contenteditable]:not([contenteditable="false"])')
          if (inText || inContentEditable) return
          e.preventDefault()
          const layout = useLayoutStore.getState()
          if (layout.dualChat) {
            layout.closeRightPanel()
          } else {
            // Open the session picker — lets the user choose which session
            // opens in the right panel instead of auto-picking the last one.
            setSessionPickerOpen(true)
          }
        }
        // ⌘+Backspace — interrupt the current agent turn
        else if (e.key === 'Backspace' && !e.shiftKey && !e.altKey) {
          const sid = useAgentStore.getState().activeSessionId
          const s = useAgentStore.getState().sessions.find((x) => x.id === sid)
          if (s && (s.status === 'running' || s.status === 'thinking')) {
            const active = document.activeElement
            const inXterm = active instanceof HTMLElement && active.classList.contains('xterm-helper-textarea')
            const inText = !inXterm && active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
            if (!inText && sid) {
              e.preventDefault()
              window.api.provider?.interrupt?.(sid).catch(() => {})
            }
          }
        }
        // ⌘+L — context bridge: append active terminal selection to the
        // chat draft. User types their question after the pasted context
        // and hits Send as normal.
        else if ((e.key === 'l' || e.key === 'L') && !e.shiftKey) {
          e.preventDefault()
          const appended = appendTerminalSelectionToDraft()
          if (!appended) {
            // eslint-disable-next-line no-console
            console.info('[Switchboard] ⌘L: no terminal selection found. Select text in a terminal first.')
          } else {
            // Focus the chat input so user can immediately type their question.
            // (ChatInput's textarea doesn't have a stable ref at the App level,
            // so we query for it.)
            setTimeout(() => {
              const ta = document.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder^="Message"], textarea[placeholder^="Queue"]'
              )
              ta?.focus()
            }, 40)
          }
        }
        // ⌘+K — quick prompt: open the floating prompt bar. Pre-fills
        // with the current terminal selection as context (if any).
        else if (e.key === 'k' || e.key === 'K') {
          e.preventDefault()
          setQuickPromptOpen(true)
        }
        // ⌘+\ — new tab in the active window
        else if (e.key === '\\' && !e.shiftKey) {
          const sid = useAgentStore.getState().activeSessionId
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
        // ⌘+⇧+] — next tab in active window
        else if (e.key === '}' || (e.key === ']' && e.shiftKey)) {
          const sid = useAgentStore.getState().activeSessionId
          if (sid) {
            e.preventDefault()
            useTerminalStore.getState().cyclePane(sid, 'next')
            const pid = useTerminalStore.getState().getActivePaneId(sid)
            if (pid) setTimeout(() => focusTerminal(pid), 40)
          }
        }
        // ⌘+⇧+[ — prev tab in active window
        else if (e.key === '{' || (e.key === '[' && e.shiftKey)) {
          const sid = useAgentStore.getState().activeSessionId
          if (sid) {
            e.preventDefault()
            useTerminalStore.getState().cyclePane(sid, 'prev')
            const pid = useTerminalStore.getState().getActivePaneId(sid)
            if (pid) setTimeout(() => focusTerminal(pid), 40)
          }
        }
        // ⌘+⌥+Arrow — navigate between windows directionally
        else if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          const sid = useAgentStore.getState().activeSessionId
          if (!sid) return
          e.preventDefault()
          const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
          useTerminalStore.getState().focusDirection(sid, dirMap[e.key as keyof typeof dirMap])
          const pid = useTerminalStore.getState().getActivePaneId(sid)
          if (pid) setTimeout(() => focusTerminal(pid), 40)
        }
        // ⌘+1..9 — focus window by index
        else if (e.key >= '1' && e.key <= '9') {
          const sid = useAgentStore.getState().activeSessionId
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
  }, [toggleSidebar, toggleTerminal])

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
        <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: '12px' }}>
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

      {/* Body — flat flex row, all panels always mounted */}
      <div style={{ flex: '1 1 0%', display: 'flex', minHeight: 0 }}>
        {/* Sidebar */}
        <div
          ref={sidebarRef}
          style={{
            width: `${sidebarWidth}px`,
            flexShrink: 0,
            overflow: 'hidden',
            display: 'flex',
            borderRight: sidebarVisible ? '1px solid var(--border)' : 'none',
          }}
        >
          <Sidebar onNewChat={handleNewChat} onSessionSelect={handleSessionSelect} />
        </div>

        {/* Sidebar divider */}
        <ResizeHandle
          direction="horizontal"
          beforeRef={sidebarRef}
          min={140}
          max={500}
          onResizeEnd={handleSidebarResizeEnd}
          visible={sidebarVisible}
        />

        {/* Chat — fills remaining space. In dual mode, renders two
            ChatPanels side-by-side with a draggable divider.
            Ratio lives in refs during drag for perf; on release we commit
            to the store so it persists on layout changes / remount. */}
        {dualChat && rightSessionId ? (
          <DualChatPanels rightSessionId={rightSessionId} />
        ) : (
          <div style={{ flex: '1 1 0%', display: 'flex', minWidth: 0, overflow: 'hidden' }}>
            <ChatPanel />
          </div>
        )}

        {/* Terminal divider */}
        <ResizeHandle
          direction="horizontal"
          afterRef={terminalRef}
          beforeRef={sidebarRef}
          invert
          min={200}
          max={800}
          onResizeEnd={handleTerminalResizeEnd}
          visible={terminalVisible}
        />

        {/* Terminal */}
        <div
          ref={terminalRef}
          style={{
            width: `${terminalWidth}px`,
            flexShrink: 0,
            overflow: 'hidden',
            display: 'flex',
            borderLeft: terminalVisible ? '1px solid var(--border)' : 'none',
          }}
        >
          <TerminalStrip />
        </div>
      </div>

      <StatusBar />

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
        onPick={(id) => openRightPanel(id)}
        excludeIds={
          useAgentStore.getState().activeSessionId
            ? [useAgentStore.getState().activeSessionId as string]
            : []
        }
        title="Open in right panel"
      />
      <QuickPromptModal
        open={quickPromptOpen}
        onClose={() => setQuickPromptOpen(false)}
      />
      <FeatureTourModal
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        startAt={tourStartAt}
        onTryIt={handleTryIt}
      />
    </div>
  )
}

/**
 * Dual-chat container — renders two ChatPanels and a performant split
 * handle between them. The ratio is written directly to the two panels'
 * `flexGrow` via refs during drag (no React re-renders, no store churn).
 * On release, the final ratio is committed to layout-store so it survives
 * remount / layout changes.
 */
function DualChatPanels({ rightSessionId }: { rightSessionId: string }) {
  const chatSplitRatio = useLayoutStore((s) => s.chatSplitRatio)
  const setChatSplitRatio = useLayoutStore((s) => s.setChatSplitRatio)
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const closeLeftPanel = useLayoutStore((s) => s.closeLeftPanel)
  const setActiveSession = useAgentStore((s) => s.setActiveSession)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  return (
    <>
      <div
        ref={leftRef}
        data-chat-panel="left"
        style={{
          flex: `${chatSplitRatio} 1 0%`,
          display: 'flex',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {/* Left X: promote the right session into the sole panel. */}
        <ChatPanel onClose={() => closeLeftPanel(setActiveSession)} />
      </div>
      <ChatSplitHandle
        leftRef={leftRef}
        rightRef={rightRef}
        initialRatio={chatSplitRatio}
        onCommit={setChatSplitRatio}
      />
      <div
        ref={rightRef}
        data-chat-panel="right"
        style={{
          flex: `${1 - chatSplitRatio} 1 0%`,
          display: 'flex',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {/* Right X: just close the right panel, left stays as sole. */}
        <ChatPanel sessionIdOverride={rightSessionId} onClose={closeRightPanel} />
      </div>
    </>
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
}: {
  leftRef: React.RefObject<HTMLDivElement | null>
  rightRef: React.RefObject<HTMLDivElement | null>
  initialRatio: number
  onCommit: (ratio: number) => void
}) {
  const activePointerRef = useRef<number | null>(null)
  const currentRatioRef = useRef(initialRatio)

  return (
    <div
      style={{
        width: '4px',
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'var(--border)',
        position: 'relative',
      }}
      onPointerDown={(e) => {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        activePointerRef.current = e.pointerId
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(e) => {
        if (activePointerRef.current !== e.pointerId) return
        const row = (e.currentTarget as HTMLElement).parentElement
        if (!row) return
        const rect = row.getBoundingClientRect()
        const local = e.clientX - rect.left
        const ratio = Math.max(0.2, Math.min(0.8, local / rect.width))
        currentRatioRef.current = ratio
        // Direct DOM writes — no React re-render during drag.
        if (leftRef.current) leftRef.current.style.flex = `${ratio} 1 0%`
        if (rightRef.current) rightRef.current.style.flex = `${1 - ratio} 1 0%`
      }}
      onPointerUp={(e) => {
        if (activePointerRef.current !== e.pointerId) return
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        activePointerRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        // Commit final ratio to store so it persists on remount.
        onCommit(currentRatioRef.current)
      }}
    />
  )
}
