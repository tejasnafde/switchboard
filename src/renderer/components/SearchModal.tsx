import { useState, useCallback, useRef, useEffect } from 'react'
import { AppChannels } from '@shared/ipc-channels'
import { agentShortLabel, providerKindFor, toAgentProvider } from '@shared/types'
import { formatRelativeTime } from '@shared/format'
import { parseArchiveIntent } from '@shared/archive-intent'
import type { MessageSearchResult } from '@shared/message-search'
import { useAgentStore } from '../stores/agent-store'
import { useMachineStore } from '../stores/machine-store'
import { renderSearchResultSnippetHtml } from './search-snippet'
import { searchMessagesOnMachines, type MachineSearchHit, type SearchTarget } from '../services/message-search'
import { createRendererLogger } from '../logger'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const log = createRendererLogger('search-modal')

interface SearchModalProps {
  open: boolean
  onClose: () => void
  /**
   * Open the hit's chat the way the sidebar does (on its own machine) and
   * resolve to the id of the chat now shown, or null when it did not open.
   */
  onOpenChat: (hit: MachineSearchHit) => Promise<string | null>
}

/** This machine plus every connected remote, each searched on its own backend. */
function searchTargets(): SearchTarget[] {
  const { remotes, connections } = useMachineStore.getState()
  return [
    { machineId: 'local', search: (q) => window.api.app.searchMessages(q) as Promise<MessageSearchResult[]> },
    ...remotes
      .filter((machine) => connections[machine.id] === 'connected')
      .map((machine): SearchTarget => ({
        machineId: machine.id,
        search: (q) => window.api.routing.invokeOn<MessageSearchResult[]>(machine.id, AppChannels.SEARCH_MESSAGES, q),
      })),
  ]
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

const AGENT_AVATAR = {
  claude: { initials: 'CL', className: 'bg-[#6c5ce7]' },
  codex: { initials: 'CX', className: 'bg-[#10a37f]' },
  opencode: { initials: 'OC', className: 'bg-[#8a8a96]' },
} as const

function agentName(agentType: string): string {
  return agentShortLabel(toAgentProvider(agentType))
}

export function SearchModal({ open, onClose, onOpenChat }: SearchModalProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MachineSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped by every keystroke and every open, so a slow answer to an older
  // query never replaces the results of a newer one.
  const ticketRef = useRef(0)
  const remotes = useMachineStore((s) => s.remotes)
  const requestChatFind = useAgentStore((s) => s.requestChatFind)

  useEffect(() => {
    if (open) {
      ticketRef.current += 1
      setQuery('')
      setResults([])
      setSearching(false)
      setActiveIdx(0)
    }
  }, [open])

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const handleSearch = useCallback((q: string) => {
    setQuery(q)
    const ticket = ++ticketRef.current
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (q.trim().length < 2) {
      setResults([])
      setSearching(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const hits = await searchMessagesOnMachines(q.trim(), searchTargets())
      if (ticket !== ticketRef.current) return
      setResults(hits)
      setActiveIdx(0)
      setSearching(false)
    }, 200)
  }, [])

  const handleSelect = useCallback(async (hit: MachineSearchHit) => {
    const findQuery = parseArchiveIntent(query).query.trim()
    // Close first: the dialog hands focus back as it closes, and the chat's
    // find bar has to take it after that.
    onClose()
    let shownId: string | null = null
    try {
      shownId = await onOpenChat(hit)
    } catch (err) {
      log.warn('opening a search hit failed', { machineId: hit.machineId, err })
    }
    if (!shownId || !findQuery) return
    requestChatFind(shownId, findQuery, hit.messageId)
  }, [query, onClose, onOpenChat, requestChatFind])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const pick = results[activeIdx]
      if (pick) {
        e.preventDefault()
        void handleSelect(pick)
      }
    }
  }

  const chatCount = new Set(results.map((r) => `${r.machineId}:${r.conversationId}`)).size

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
        onKeyDown={onKeyDown}
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
        <div ref={listRef} className="flex-1 overflow-y-auto p-[4px]">
          {results.length === 0 && query.trim().length >= 2 && !searching && (
            <div className="p-[24px] text-center text-[13px] text-[var(--text-muted)]">
              No results found
            </div>
          )}

          {results.map((r, i) => {
            const avatar = AGENT_AVATAR[providerKindFor(r.agentType)]
            const machine = r.machineId === 'local' ? null : remotes.find((m) => m.id === r.machineId)?.name ?? r.machineId
            const meta = [
              machine,
              projectName(r.projectPath),
              agentName(r.agentType),
              r.timestamp ? formatRelativeTime(r.timestamp) : null,
            ].filter(Boolean).join(' · ')
            const selected = i === activeIdx
            return (
              <button
                key={`${r.machineId}:${r.messageId}`}
                type="button"
                data-selected={selected}
                onClick={() => { void handleSelect(r) }}
                onMouseMove={() => { if (!selected) setActiveIdx(i) }}
                className="cmdk-item block w-full cursor-pointer rounded-[6px] border-0 bg-transparent px-[12px] py-[8px] text-left text-[13px] text-[var(--text-primary)]"
              >
                <div className="flex min-w-0 items-center gap-[8px]">
                  <span
                    aria-hidden
                    className={cn('inline-flex size-[16px] shrink-0 items-center justify-center rounded-full text-[8px] text-white', avatar.className)}
                  >
                    {avatar.initials}
                  </span>
                  <span className="min-w-0 truncate font-[500]">{r.conversationTitle.trim() || 'Untitled chat'}</span>
                  {r.archived && (
                    <span className="shrink-0 rounded-[3px] bg-[var(--bg-tertiary)] px-[5px] text-[10px] text-[var(--text-muted)]">
                      Archived
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[11.5px] text-[var(--text-muted)]">{meta}</span>
                </div>
                <div className="mt-[3px] line-clamp-2 text-[12px] leading-[1.5] text-[var(--text-secondary)]">
                  <span className={cn(
                    'mr-[6px] rounded-[3px] px-[5px] py-[1px] text-[10px] font-[500]',
                    r.role === 'user' ? 'bg-[var(--accent-subtle)] text-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                  )}>
                    {r.role === 'user' ? 'you' : agentName(r.agentType)}
                  </span>
                  <span dangerouslySetInnerHTML={{ __html: renderSearchResultSnippetHtml(r) }} />
                </div>
              </button>
            )
          })}
        </div>
        {results.length > 0 && (
          <div className="flex gap-[14px] border-t border-[var(--border)] px-[12px] py-[6px] text-[11px] text-[var(--text-muted)]">
            <span>
              {chatCount} {chatCount === 1 ? 'chat' : 'chats'}, {results.length} {results.length === 1 ? 'match' : 'matches'}
            </span>
            <span>↑↓ navigate</span>
            <span>Enter open at the message</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
