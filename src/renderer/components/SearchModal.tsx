import { useState, useCallback, useRef, useEffect } from 'react'
import { useAgentStore } from '../stores/agent-store'
import type { ChatMessage, AgentType } from '@shared/types'

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
      setTimeout(() => inputRef.current?.focus(), 50)
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
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
  }, [])

  const handleSelect = useCallback(async (result: SearchResult) => {
    const store = useAgentStore.getState()
    const existing = store.sessions.find((s) => s.id === result.conversationId)

    // Hydrate the session if it isn't already in the agent store. Search
    // hits often reference chats from previous launches that were scanned
    // into the DB/FTS index but never addSession()'d this run.
    if (!existing) {
      try {
        const resp = await window.api.app.loadSessionById(result.conversationId) as {
          messages: ChatMessage[]
          meta: { id: string; title: string; projectPath: string; agentType: string } | null
        }
        if (resp.meta) {
          addSession({
            id: resp.meta.id,
            type: (resp.meta.agentType === 'codex' ? 'codex' : 'claude-code') as AgentType,
            status: 'idle',
            projectPath: resp.meta.projectPath,
            resumeSessionId: resp.meta.id,
            title: resp.meta.title,
          })
          if (resp.messages.length > 0) setMessages(resp.meta.id, resp.messages)
        }
      } catch {
        /* best-effort — setActiveSession still fires below */
      }
    }

    setActiveSession(result.conversationId)
    // Ask MessageList to jump the virtualizer to this message. The effect
    // there retries until the message shows up in the turns array (gives
    // setMessages a chance to land).
    requestScrollToMessage(result.conversationId, result.messageId)
    onClose()
  }, [setActiveSession, requestScrollToMessage, addSession, setMessages, onClose])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '15vh',
        background: 'rgba(0, 0, 0, 0.4)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="palette-modal-content"
        style={{
          width: '560px',
          maxHeight: '440px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.3)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Search input */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          gap: '8px',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
            placeholder="Search across all conversations..."
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: '14px',
              outline: 'none',
            }}
          />
          {searching && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Searching...</span>
          )}
        </div>

        {/* Results */}
        <div style={{
          overflowY: 'auto',
          padding: '4px',
          flex: 1,
        }}>
          {results.length === 0 && query.trim().length >= 2 && !searching && (
            <div style={{
              padding: '24px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '13px',
            }}>
              No results found
            </div>
          )}

          {results.map((r, i) => (
            <button
              key={`${r.messageId}_${i}`}
              onClick={() => handleSelect(r)}
              style={{
                display: 'block',
                width: '100%',
                padding: '10px 12px',
                borderRadius: '6px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text-primary)',
                fontSize: '13px',
              }}
              className="cmdk-item"
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                marginBottom: '4px',
              }}>
                <span style={{
                  fontSize: '10px',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: r.role === 'user' ? 'var(--accent-subtle)' : 'var(--bg-tertiary)',
                  color: r.role === 'user' ? 'var(--accent)' : 'var(--text-muted)',
                  fontWeight: 500,
                }}>
                  {r.role}
                </span>
                <span style={{
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {r.conversationId.slice(0, 12)}...
                </span>
              </div>
              <div style={{
                fontSize: '12px',
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
                dangerouslySetInnerHTML={{
                  __html: r.snippet
                    .replace(/\*\*/g, '<mark style="background: var(--accent-subtle); color: var(--accent); border-radius: 2px; padding: 0 2px;">')
                    .replace(/<mark[^>]*>/g, (m) => m)
                    // Close marks — snippet uses ** delimiters
                }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
