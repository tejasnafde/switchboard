import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useAgentStore } from '../../stores/agent-store'
import { ensureFullHistory } from '../../services/history-loader'
import type { ChatSlot } from '../../services/chat-workspace'
import { matchesShortcut } from '@shared/shortcuts'
import { textMatchesSearch } from '@shared/message-search'

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
  const pendingChatFind = useAgentStore((s) => s.pendingChatFind)
  const clearChatFind = useAgentStore((s) => s.clearChatFind)
  // A find opened by message search: the text it starts with (the bar is
  // keyed by `stamp`, so a second prefill replaces the first) and the message
  // the cursor starts on once that message is among the matches.
  const [findPrefill, setFindPrefill] = useState<{ query: string; stamp: number } | null>(null)
  const anchorRef = useRef<{ sessionId: string; messageId: string; scrolled: boolean } | null>(null)

  useEffect(() => {
    if (!pendingChatFind || !sessionId || pendingChatFind.sessionId !== sessionId) return
    clearChatFind()
    anchorRef.current = { sessionId, messageId: pendingChatFind.messageId, scrolled: false }
    setFindPrefill({ query: pendingChatFind.query, stamp: pendingChatFind.stamp })
    setSearchOpen(true)
    setSearchQuery(pendingChatFind.query)
    setSearchIdx(0)
  }, [pendingChatFind, sessionId, clearChatFind])

  // Bumped when the full history fails to load, so the cursor stops waiting
  // for an anchor that cannot arrive.
  const [anchorLost, setAnchorLost] = useState(0)

  // A long chat opens with its newest window; search covers all of it.
  useEffect(() => {
    if (!searchOpen || !sessionId) return
    void ensureFullHistory(sessionId).then((complete) => {
      const anchor = anchorRef.current
      if (complete || anchor?.sessionId !== sessionId) return
      anchorRef.current = null
      const pending = useAgentStore.getState().pendingScrollToMessage
      if (pending?.sessionId === sessionId && pending.messageId === anchor.messageId) {
        useAgentStore.getState().clearScrollToMessage()
      }
      setAnchorLost((n) => n + 1)
    })
  }, [searchOpen, sessionId])

  // ── In-pane search: matching message ids (the text, or every word of it) ──
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [] as string[]
    // Search the user-visible text content. Tool calls / images aren't
    // included; the global ⌘⇧F covers FTS over the full DB.
    return messages
      .filter((m) => typeof m.content === 'string' && textMatchesSearch(m.content, searchQuery))
      .map((m) => m.id)
  }, [searchQuery, messages])

  // Whenever the query or message list changes, clamp the cursor and
  // ask MessageList to jump to the current match.
  useEffect(() => {
    if (!searchOpen) return
    // The panel moved to another chat: that anchor names a message it lacks.
    if (anchorRef.current && anchorRef.current.sessionId !== sessionId) anchorRef.current = null
    const anchor = anchorRef.current
    if (anchor && sessionId) {
      const at = searchMatches.indexOf(anchor.messageId)
      if (at < 0) {
        // Not loaded yet (the full history is still coming) or not a match
        // here: show the message itself, once, and wait for the list.
        if (!anchor.scrolled) {
          anchor.scrolled = true
          requestScrollToMessage(sessionId, anchor.messageId, searchQuery)
        }
        return
      }
      anchorRef.current = null
      if (at !== searchIdx) {
        setSearchIdx(at)
        return
      }
    }
    if (searchMatches.length === 0) return
    const safe = ((searchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length
    if (safe !== searchIdx) {
      setSearchIdx(safe)
      return
    }
    if (sessionId) requestScrollToMessage(sessionId, searchMatches[safe], searchQuery)
  }, [searchOpen, searchMatches, searchIdx, sessionId, searchQuery, requestScrollToMessage, anchorLost])

  const handleChatSearchQuery = useCallback((q: string) => {
    anchorRef.current = null
    setSearchQuery(q)
    setSearchIdx(0)
  }, [])
  const handleChatSearchNext = useCallback(() => {
    anchorRef.current = null
    setSearchIdx((i) => i + 1)
  }, [])
  const handleChatSearchPrev = useCallback(() => {
    anchorRef.current = null
    setSearchIdx((i) => i - 1)
  }, [])
  const handleChatSearchClose = useCallback(() => {
    anchorRef.current = null
    setFindPrefill(null)
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
      // ⌘F on macOS, Ctrl+F on Windows/Linux.
      if (!matchesShortcut(e, 'pane.find')) return
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
    findPrefill,
    chatSearchMatchInfo,
    handleChatSearchQuery,
    handleChatSearchNext,
    handleChatSearchPrev,
    handleChatSearchClose,
  }
}
