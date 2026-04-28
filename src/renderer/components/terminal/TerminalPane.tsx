import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTerminal } from '../../hooks/useTerminal'
import { TerminalHeader } from './TerminalHeader'
import { useTerminalStore } from '../../stores/terminal-store'
import type { TerminalStatus } from '@shared/types'
import { InPaneSearchBar } from '../InPaneSearchBar'
import {
  searchTerminalNext,
  searchTerminalPrev,
  clearTerminalSearch,
  onTerminalSearchResults,
  focusTerminal,
} from '../../services/terminal-registry'

interface TerminalPaneProps {
  id: string
  sessionId: string
  label: string
  status: TerminalStatus
  isActive: boolean
  cwd?: string
  command?: string
  wait_for?: string
  /**
   * Pane was restored from a saved layout and hasn't been manually
   * started yet. Renders a "Start terminal" overlay instead of
   * spawning a PTY — avoids silently re-running long commands
   * (e.g. `npm run dev`) on every app launch.
   */
  stale?: boolean
  onClose: () => void
  onFocus: () => void
  /** When used inside TerminalWindow, the window renders its own header */
  hideHeader?: boolean
}

export const TerminalPane = memo(function TerminalPane(props: TerminalPaneProps) {
  const { stale, label, status, isActive, onClose, onFocus, hideHeader, id } = props
  const [searchOpen, setSearchOpen] = useState(false)
  const queryRef = useRef('')
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Subscribe to xterm match-count events while the bar is open.
  useEffect(() => {
    if (!searchOpen) return
    return onTerminalSearchResults(id, ({ resultIndex, resultCount }) => {
      if (resultCount <= 0 || resultIndex < 0) {
        setMatches({ current: 0, total: resultCount > 0 ? resultCount : 0 })
      } else {
        setMatches({ current: resultIndex + 1, total: resultCount })
      }
    })
  }, [searchOpen, id])

  // ⌘F (macOS) / Ctrl+F (Windows/Linux) intercept — document-level so
  // we catch the keydown even when focus is somewhere ambiguous (body,
  // container without tabIndex). Scope: only fire when activeElement
  // is INSIDE this pane's subtree (i.e. the user has actually focused
  // this terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Accept either modifier so the same shortcut works on both
      // platforms. `!both` blocks Ctrl+Cmd+F, which is the macOS
      // fullscreen toggle muscle memory; we don't want to fight that.
      const cmd = e.metaKey && !e.ctrlKey
      const ctrl = e.ctrlKey && !e.metaKey
      if (!((cmd || ctrl) && !e.altKey && !e.shiftKey)) return
      if (e.key !== 'f' && e.key !== 'F') return
      const wrap = wrapperRef.current
      if (!wrap) return
      const active = document.activeElement as Element | null
      if (!active) return
      // Must be focused inside THIS terminal pane.
      if (!wrap.contains(active)) return
      e.preventDefault()
      e.stopPropagation()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const handleQuery = useCallback((q: string) => {
    queryRef.current = q
    if (q === '') {
      clearTerminalSearch(id)
      setMatches({ current: 0, total: 0 })
      return
    }
    searchTerminalNext(id, q)
  }, [id])

  const handleNext = useCallback(() => {
    if (queryRef.current) searchTerminalNext(id, queryRef.current)
  }, [id])

  const handlePrev = useCallback(() => {
    if (queryRef.current) searchTerminalPrev(id, queryRef.current)
  }, [id])

  const handleClose = useCallback(() => {
    clearTerminalSearch(id)
    setSearchOpen(false)
    setMatches(null)
    queryRef.current = ''
    // Send focus back to the terminal so the user can keep typing.
    focusTerminal(id)
  }, [id])

  return (
    <div
      ref={wrapperRef}
      data-terminal-pane="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        minHeight: 0,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        height: '100%',
      }}
    >
      {!hideHeader && (
        <TerminalHeader
          label={label}
          status={status}
          isActive={isActive}
          onClose={onClose}
          onClick={onFocus}
        />
      )}
      <div style={{ flex: '1 1 0%', position: 'relative', minHeight: 0 }}>
        {stale
          ? <StalePaneOverlay sessionId={props.sessionId} id={props.id} command={props.command} cwd={props.cwd} />
          : <LivePane {...props} wait_for={props.wait_for} />}
        {searchOpen && (
          <InPaneSearchBar
            onQuery={handleQuery}
            onNext={handleNext}
            onPrev={handlePrev}
            onClose={handleClose}
            matches={matches}
            placeholder="Find in terminal"
          />
        )}
      </div>
    </div>
  )
})

function LivePane({ id, sessionId, cwd, command, wait_for, onFocus }: TerminalPaneProps & { wait_for?: string }) {
  const { containerRef } = useTerminal({ id, sessionId, cwd, initialCommand: command, waitFor: wait_for })
  return (
    <div
      ref={containerRef}
      onClick={onFocus}
      style={{
        position: 'absolute',
        inset: 0,
        padding: '4px',
        background: 'var(--terminal-bg)',
      }}
    />
  )
}

/**
 * Overlay shown when a pane is restored from saved layout. User clicks
 * "Start" to spawn the PTY — prevents silent re-runs of long-running
 * commands on every app launch.
 */
function StalePaneOverlay({
  sessionId,
  id,
  command,
  cwd,
}: {
  sessionId: string
  id: string
  command?: string
  cwd?: string
}) {
  const markStarted = useTerminalStore((s) => s.markPaneStarted)

  return (
    <div
      onClick={() => markStarted(sessionId, id)}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--terminal-bg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: '24px',
        cursor: 'pointer',
        color: 'var(--text-secondary)',
      }}
    >
      <div style={{
        fontSize: '10.5px',
        textTransform: 'uppercase',
        letterSpacing: '0.8px',
        color: 'var(--text-muted)',
        fontWeight: 600,
      }}>
        Restored from previous session
      </div>
      {command && (
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          color: 'var(--text-primary)',
          padding: '6px 10px',
          background: 'var(--bg-tertiary)',
          borderRadius: '4px',
          border: '1px solid var(--border)',
          maxWidth: '90%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {command}
        </div>
      )}
      {cwd && (
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          {cwd}
        </div>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); markStarted(sessionId, id) }}
        style={{
          padding: '6px 18px',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--accent)',
          background: 'var(--accent-subtle)',
          color: 'var(--accent)',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 600,
        }}
      >
        Start terminal
      </button>
    </div>
  )
}
