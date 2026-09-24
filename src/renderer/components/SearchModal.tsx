import { useState, useCallback, useRef, useEffect } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { renderSnippetHtml } from './search-snippet'
import { resolveSessionSelectTarget } from '../utils/session-eviction'
import type { ChatMessage } from '@shared/types'
import {
  projectLoadedSearchSession,
  type LoadedSearchSessionMeta,
} from '../services/search-session-projection'
import { createRendererLogger } from '../logger'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const log = createRendererLogger('search-modal')

interface SearchResult {
  messageId: string
  conversationId: string
  role: string
  content: string
  snippet: string
}

interface SearchModalProps {
  open: boolean
  onClose: () => void
}

export function SearchModal({ open, onClose }: SearchModalProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setActiveSession = useAgentStore((s) => s.setActiveSession)
  const requestScrollToMessage = useAgentStore((s) => s.requestScrollToMessage)
  const addSession = useAgentStore((s) => s.addSession)
  const setMessages = useAgentStore((s) => s.setMessages)

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
    }
  }, [open])

  const handleSearch = useCallback((q: string) => {
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (q.trim().length < 2) {
      setResults([])
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await window.api.app.searchMessages(q.trim())
        setResults(res ?? [])
      } catch (err) {
        log.warn('searchMessages failed', err)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
  }, [])

  const handleSelect = useCallback(async (result: SearchResult) => {
    const store = useAgentStore.getState()
    const existing = store.sessions.find((s) => s.id === result.conversationId)
    let targetId = result.conversationId

    // Hydrate the session if it isn't already in the agent store. Search
    // hits often reference chats from previous launches that were scanned
    // into the DB/FTS index but never addSession()'d this run.
    if (!existing) {
      try {
        const resp = await window.api.app.loadSessionById(result.conversationId) as {
          messages: ChatMessage[]
          meta: LoadedSearchSessionMeta | null
        }
        // A hit can name a rotated id whose live thread is already in the
        // store; adding it again would build an unreachable twin.
        targetId = resolveSessionSelectTarget(
          result.conversationId,
          resp?.meta?.rootThreadId,
          store.sessions.map((s) => s.id),
        )
        if (resp.meta && targetId === result.conversationId) {
          addSession(projectLoadedSearchSession(resp.meta))
          if (resp.messages.length > 0) setMessages(resp.meta.id, resp.messages)
        }
      } catch (err) {
        log.warn(`loadSessionById failed for ${result.conversationId} - best-effort, setActiveSession still fires below`, err)
      }
    }

    setActiveSession(targetId)
    // Ask MessageList to jump the virtualizer to this message. The effect
    // there retries until the message shows up in the turns array (gives
    // setMessages a chance to land).
    requestScrollToMessage(targetId, result.messageId)
    onClose()
  }, [setActiveSession, requestScrollToMessage, addSession, setMessages, onClose])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
        overlayClassName="z-[1000] bg-[rgba(0,0,0,0.4)]"
        // A fixed height, not max-height: the box keeps its size while results
        // come and go, as it did when the backdrop's flex row stretched it.
        className="palette-modal-content inset-x-0 top-[15vh] z-[1000] mx-auto flex h-[min(440px,85vh)] w-[560px] flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_16px_48px_rgba(0,0,0,0.3)]"
      >
        <DialogTitle className="sr-only">Search across all conversations</DialogTitle>
        {/* Search input */}
        <div className="flex items-center gap-[8px] border-b border-[var(--border)] px-[16px] py-[12px]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search across all conversations..."
            className="flex-1 border-0 bg-transparent text-[14px] text-[var(--text-primary)] outline-none"
          />
          {searching && (
            <span className="text-[11px] text-[var(--text-muted)]">Searching...</span>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-[4px]">
          {results.length === 0 && query.trim().length >= 2 && !searching && (
            <div className="p-[24px] text-center text-[13px] text-[var(--text-muted)]">
              No results found
            </div>
          )}

          {results.map((r, i) => (
            <button
              key={`${r.messageId}_${i}`}
              onClick={() => handleSelect(r)}
              // Rows stay untinted on hover; without the important flag
              // .cmdk-item:hover in global.css would win.
              className="cmdk-item block w-full cursor-pointer rounded-[6px] border-0 bg-transparent! px-[12px] py-[10px] text-left text-[13px] text-[var(--text-primary)]"
            >
              <div className="mb-[4px] flex items-center gap-[6px]">
                <span className={cn(
                  'rounded-[3px] px-[5px] py-[1px] text-[10px] font-[500]',
                  r.role === 'user' ? 'bg-[var(--accent-subtle)] text-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                )}>
                  {r.role}
                </span>
                <span className="text-[10px] [font-family:var(--font-mono)] text-[var(--text-muted)]">
                  {r.conversationId.slice(0, 12)}...
                </span>
              </div>
              <div
                className="line-clamp-2 text-[12px] leading-[1.5] text-[var(--text-secondary)]"
                dangerouslySetInnerHTML={{ __html: renderSnippetHtml(r.snippet) }}
              />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
