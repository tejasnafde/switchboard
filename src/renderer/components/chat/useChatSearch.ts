import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useAgentStore } from '../../stores/agent-store'
import type { ChatSlot } from '../../services/chat-workspace'

interface ChatSearchOptions {
  messages: ChatMessage[]
  sessionId: string | null | undefined
  sessionIdOverride: string | null | undefined
  chatSlot: ChatSlot | undefined
}

export function useChatSearch({ messages, sessionId, sessionIdOverride, chatSlot }: ChatSearchOptions) {
  // ── In-pane ⌘F search ────────────────────────────────────────────
  // Filters this panel's messages by substring and steps through them.
  // Reuses `requestScrollToMessage` (the same plumbing ⌘⇧F uses) so
  // the virtualizer can land on the right row + flash-highlight it.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const requestScrollToMessage = useAgentStore((s) => s.requestScrollToMessage)

  // ── In-pane search: compute matching message ids (substring on text) ──
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return [] as string[]
    return messages
      .filter((m) => {
        // Search the user-visible text content. Tool calls / images aren't
        // included; the global ⌘⇧F covers FTS over the full DB.
        if (typeof m.content === 'string' && m.content.toLowerCase().includes(q)) return true
        return false
      })
      .map((m) => m.id)
  }, [searchQuery, messages])

  // Whenever the query or message list changes, clamp the cursor and
  // ask MessageList to jump to the current match.
  useEffect(() => {
    if (!searchOpen) return
    if (searchMatches.length === 0) return
    const safe = ((searchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length
    if (safe !== searchIdx) {
      setSearchIdx(safe)
      return
    }
    if (sessionId) requestScrollToMessage(sessionId, searchMatches[safe], searchQuery)
  }, [searchOpen, searchMatches, searchIdx, sessionId, searchQuery, requestScrollToMessage])

  const handleChatSearchQuery = useCallback((q: string) => {
    setSearchQuery(q)
    setSearchIdx(0)
  }, [])
  const handleChatSearchNext = useCallback(() => {
    setSearchIdx((i) => i + 1)
  }, [])
  const handleChatSearchPrev = useCallback(() => {
    setSearchIdx((i) => i - 1)
  }, [])
  const handleChatSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIdx(0)
    // Strip any <mark class="sb-search-mark"> we injected so the chat
    // returns to its normal rendering.
    document.querySelectorAll('mark.sb-search-mark').forEach((m) => {
      const parent = m.parentNode
      if (!parent) return
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    })
  }, [])

  // ⌘F intercept - uses a document-level capture listener instead of an
  // onKeyDownCapture on the wrapper, because the wrapper is only on the
  // capture path when document.activeElement is INSIDE this panel. After
  // the user clicks the chat title, sidebar, or anywhere ambiguous the
  // active element falls back to <body> and a wrapper-attached handler
  // never fires. Document-level lets us scope via a ref check + a
  // "default panel" fallback (matches activeSessionId).
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Accept ⌘F on macOS or Ctrl+F on Windows/Linux. Reject combos
      // that include both (Ctrl+Cmd+F is the macOS fullscreen toggle).
      const cmd = e.metaKey && !e.ctrlKey
      const ctrl = e.ctrlKey && !e.metaKey
      if (!((cmd || ctrl) && !e.altKey && !e.shiftKey)) return
      if (e.key !== 'f' && e.key !== 'F') return
      const el = panelRef.current
      if (!el) return
      const active = document.activeElement as Element | null
      const inThisPanel = !!active && el.contains(active)
      // If focus is inside ANOTHER chat panel (dual-chat mode), don't
      // steal - that panel's listener will handle it.
      const inAnyChatPanel = !!active && !!active.closest('[data-chat-panel="true"]')
      // If focus is inside a terminal (xterm), the terminal pane will
      // claim ⌘F via its own listener - bail so we don't double-trigger.
      const inTerminal = !!active && (
        active.classList.contains('xterm-helper-textarea') ||
        !!active.closest('.xterm') ||
        !!active.closest('[data-terminal-pane="true"]')
      )
      // If focus is inside the CM6 file editor, let it handle ⌘F natively
      // via its own searchKeymap binding - bail so we don't steal it.
      const inFileViewer = !!active && !!active.closest('[data-context-source="file-viewer"]')
      if (inTerminal || inFileViewer) return
      if (!inThisPanel) {
        if (inAnyChatPanel) return
        // Focus is somewhere neutral (body, sidebar, etc). Only the
        // "default" (active-session) panel should claim ⌘F so dual-chat
        // doesn't double-trigger.
        const isDefault = chatSlot === 'primary' || (chatSlot == null && sessionIdOverride == null)
        if (!isDefault) return
      }
      e.preventDefault()
      e.stopPropagation()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [sessionIdOverride, chatSlot])

  const chatSearchMatchInfo = searchOpen
    ? {
        current: searchMatches.length === 0 ? 0 : (searchIdx % searchMatches.length + searchMatches.length) % searchMatches.length + 1,
        total: searchMatches.length,
      }
    : null

  return {
    panelRef,
    searchOpen,
    chatSearchMatchInfo,
    handleChatSearchQuery,
    handleChatSearchNext,
    handleChatSearchPrev,
    handleChatSearchClose,
  }
}
