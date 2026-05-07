/**
 * Per-thread branch picker. Two pieces:
 *
 *   - <BranchPickerTrigger>: the `main ▾` chip that lives in the chat
 *     composer toolbar. Shows the current branch (or `(detached)`)
 *     and opens the popover on click.
 *   - <BranchPickerPopover>: the search input + list. Sort/filter is
 *     pure-policy (branchPickerPolicy.ts, unit-tested). Selecting a ref
 *     calls `git.switchRef`; the surrounding ChatInput re-fetches the
 *     current branch on close.
 *
 * Refs come from `window.api.git.listRefs(cwd)`. We re-fetch each time
 * the popover opens (cheap; user-paced); no React Query yet.
 *
 * Cross-platform: branch names from git are byte-identical across OSes,
 * so no normalization here. Worktree paths are passed through verbatim
 * so callers can compare them against the session's worktreePath exactly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rankAndFilterRefs, decideSwitchAction, type Ref } from './branchPickerPolicy'

interface TriggerProps {
  cwd: string | null
  /**
   * Called when the picker resolves to a `swap-cwd` action — the picked
   * branch already has a worktree at `newCwd`, so the caller should
   * update its session/conversation pointer to the new path. Caller
   * also persists via `app.setConversationWorktree`.
   */
  onSwapWorktree?: (newCwd: string, branch: string) => void
  /** Called whenever the popover closes after a successful checkout. */
  onChanged?: () => void
}

export function BranchPickerTrigger({ cwd, onSwapWorktree, onChanged }: TriggerProps) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!cwd) return
    const res = await window.api.git.currentBranch(cwd)
    if (res.ok) setCurrent(res.branch)
    else setCurrent(null)
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!cwd) return null

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch branch"
        style={triggerStyle}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
          {current ?? '(detached)'}
        </span>
        <span style={{ opacity: 0.6, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <BranchPickerPopover
          cwd={cwd}
          onSwapWorktree={onSwapWorktree}
          onClose={(changed) => {
            setOpen(false)
            if (changed) {
              refresh()
              onChanged?.()
            }
          }}
        />
      )}
    </div>
  )
}

interface PopoverProps {
  cwd: string
  onSwapWorktree?: (newCwd: string, branch: string) => void
  onClose: (changed: boolean) => void
}

function BranchPickerPopover({ cwd, onSwapWorktree, onClose }: PopoverProps) {
  const [refs, setRefs] = useState<Ref[]>([])
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Initial fetch
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.git.listRefs(cwd).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok) {
        setRefs(res.refs)
        setError(null)
      } else {
        setError(res.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  // Focus the input on open
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Click-outside to close
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return
      if (wrapperRef.current.contains(e.target as Node)) return
      onClose(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  const filtered = rankAndFilterRefs(refs, query)

  // Reset highlight when filter changes
  useEffect(() => {
    setActiveIdx(0)
  }, [query, refs])

  const select = useCallback(
    async (ref: Ref) => {
      if (switching) return
      const action = decideSwitchAction(ref, cwd)
      if (action.kind === 'noop') {
        onClose(false)
        return
      }
      setSwitching(ref.name)
      if (action.kind === 'swap-cwd') {
        // No git command — the picked branch already lives in another
        // worktree on disk. Caller persists the new cwd onto its
        // session/conversation row.
        onSwapWorktree?.(action.newCwd, ref.name)
        setSwitching(null)
        onClose(true)
        return
      }
      // action.kind === 'checkout'
      const res = await window.api.git.switchRef(action.cwd, action.refName)
      setSwitching(null)
      if (!res.ok) {
        setError(res.error)
        return
      }
      onClose(true)
    },
    [cwd, onClose, onSwapWorktree, switching],
  )

  return (
    <div
      ref={wrapperRef}
      className="sb-floating-surface"
      style={popoverStyle}
      role="listbox"
      aria-label="Branches"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose(false)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIdx((i) => Math.min(filtered.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIdx((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const target = filtered[activeIdx]
          if (target) select(target)
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search branches…"
        style={inputStyle}
      />
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {loading && <div style={emptyRowStyle}>Loading…</div>}
        {!loading && error && <div style={{ ...emptyRowStyle, color: 'var(--accent-red, #f88)' }}>{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div style={emptyRowStyle}>No branches match "{query}"</div>
        )}
        {!loading && !error && filtered.map((ref, i) => (
          <button
            key={`${ref.isRemote ? 'r' : 'l'}:${ref.name}`}
            type="button"
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => select(ref)}
            style={{
              ...rowStyle,
              background: i === activeIdx ? 'var(--bg-active, var(--bg-tertiary))' : 'transparent',
              opacity: switching && switching !== ref.name ? 0.5 : 1,
            }}
            disabled={switching !== null && switching !== ref.name}
            role="option"
            aria-selected={i === activeIdx}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: ref.current ? 600 : 400 }}>{ref.name}</span>
            </span>
            {ref.current && <span style={tagStyle}>current</span>}
            {ref.isRemote && <span style={tagStyle}>remote</span>}
            {ref.worktreePath && !ref.current && <span style={tagStyle}>worktree</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── styles ────────────────────────────────────────────────────────

const triggerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '3px 8px',
  fontSize: 11,
  cursor: 'pointer',
  outline: 'none',
}

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: 0,
  width: 320,
  zIndex: 100,
  borderRadius: 6,
  boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  overflow: 'hidden',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: 'none',
  borderBottom: '1px solid var(--border)',
  padding: '8px 12px',
  fontSize: 12,
  outline: 'none',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: 'none',
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'left',
}

const emptyRowStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 12,
  color: 'var(--text-muted)',
  fontStyle: 'italic',
}

const tagStyle: React.CSSProperties = {
  fontSize: 9.5,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}
