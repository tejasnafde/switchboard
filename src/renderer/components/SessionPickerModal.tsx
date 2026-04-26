import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../stores/agent-store'

interface SessionPickerModalProps {
  open: boolean
  onClose: () => void
  onPick: (sessionId: string) => void
  /** Session IDs to exclude from the picker (e.g. the currently-active one). */
  excludeIds?: string[]
  title?: string
}

/**
 * Small picker modal for selecting a session to open in a side-by-side
 * chat panel. Used by the ⌘⇧\ keybinding and the "open right panel" flow.
 *
 * Keyboard-first: ↑/↓ to navigate, Enter to pick, Esc to dismiss.
 */
export function SessionPickerModal({
  open,
  onClose,
  onPick,
  excludeIds = [],
  title = 'Open in right panel',
}: SessionPickerModalProps) {
  const sessions = useAgentStore((s) => s.sessions)
  const [activeIdx, setActiveIdx] = useState(0)

  const candidates = useMemo(
    () => sessions.filter((s) => !excludeIds.includes(s.id)),
    [sessions, excludeIds],
  )

  useEffect(() => {
    if (open) setActiveIdx(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, candidates.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const pick = candidates[activeIdx]
        if (pick) {
          onPick(pick.id)
          onClose()
        }
      }
    }
    // Capture-phase so we beat the global keybinding listener
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, activeIdx, candidates, onPick, onClose])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '18vh',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)',
          maxHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
          fontWeight: 600,
        }}>
          {title}
        </div>
        {candidates.length === 0 ? (
          <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>
            No other sessions open. Start or select another chat first.
          </div>
        ) : (
          <div style={{ overflowY: 'auto', padding: '4px 0' }}>
            {candidates.map((s, i) => {
              const selected = i === activeIdx
              return (
                <button
                  key={s.id}
                  onClick={() => { onPick(s.id); onClose() }}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    padding: '8px 14px',
                    gap: '8px',
                    alignItems: 'baseline',
                    border: 'none',
                    background: selected ? 'var(--bg-hover)' : 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10px',
                    color: selected ? 'var(--accent)' : 'var(--text-muted)',
                    minWidth: '46px',
                  }}>
                    {s.type === 'codex' ? 'Codex' : s.type === 'opencode' ? 'OpenCode' : 'Claude'}
                  </span>
                  <span style={{
                    flex: 1,
                    fontSize: '13px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {s.title ?? s.id.slice(0, 8)}
                  </span>
                  {s.projectPath && (
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '10.5px',
                      color: 'var(--text-muted)',
                    }}>
                      {s.projectPath.split('/').pop()}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <div style={{
          padding: '6px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
          display: 'flex',
          gap: '10px',
        }}>
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          <span>Esc dismiss</span>
        </div>
      </div>
    </div>
  )
}
