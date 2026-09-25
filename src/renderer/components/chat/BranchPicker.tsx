/**
 * Per-thread branch picker. Two pieces:
 *
 *   - <BranchPickerTrigger>: the `main ▾` chip that lives in the chat
 *     composer toolbar. Shows the current branch (or `(detached)`)
 *     and opens the popover on click.
 *   - <BranchPickerPopover>: the search input + list. Sort/filter is
 *     pure-policy (branch-picker-policy.ts, unit-tested). Selecting a ref
 *     calls `git.switchRef`; the surrounding ChatInput re-fetches the
 *     current branch on close.
 *
 * While the chat's Follow suggestions are off (muted, or past the worktree
 * cut-off), the popover ends with "Turn Follow suggestions back on", so the
 * choice stays reversible after the composer's notice was closed.
 *
 * Refs come from `window.api.git.listRefs(cwd)`. We re-fetch each time
 * the popover opens (cheap; user-paced); no React Query yet.
 *
 * Cross-platform: branch names from git are byte-identical across OSes,
 * so no normalization here. Worktree paths are passed through verbatim
 * so callers can compare them against the session's worktreePath exactly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRendererLogger } from '../../logger'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { rankAndFilterRefs, decideSwitchAction, type Ref } from './branch-picker-policy'
import { followSuggestionsOff } from '@shared/follow-suggestions'

const log = createRendererLogger('chat:branch-picker')

interface TriggerProps {
  cwd: string | null
  /**
   * Called when the picker resolves to a `swap-cwd` action - the picked
   * branch already has a worktree at `newCwd`, so the caller should
   * update its session/conversation pointer to the new path. Caller
   * also persists via `app.setConversationWorktree`.
   */
  onSwapWorktree?: (newCwd: string, branch: string) => void
  /** Called whenever the popover closes after a successful checkout. */
  onChanged?: () => void
  /** The cwd itself no longer exists (deleted worktree) - owner can heal the pointer. */
  onCwdMissing?: () => void
  /** The conversation whose Follow suggestions the popover can turn back on. */
  followSessionId?: string
  onTurnFollowBackOn?: () => void
}

export function BranchPickerTrigger({ cwd, onSwapWorktree, onChanged, onCwdMissing, followSessionId, onTurnFollowBackOn }: TriggerProps) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const [isGitRepo, setIsGitRepo] = useState(true)

  const refresh = useCallback(async () => {
    if (!cwd) return
    const res = await window.api.git.currentBranch(cwd)
    if (res.ok) {
      setCurrent(res.branch)
      setIsGitRepo(true)
    } else if ((res as { missing?: boolean }).missing) {
      // Deleted worktree: hide the chip and let the owner reset the session
      // pointer back to the main clone instead of rendering spawn errors.
      setCurrent(null)
      setIsGitRepo(false)
      onCwdMissing?.()
    } else {
      setCurrent(null)
      setIsGitRepo(!/not a git repository/i.test(res.error))
    }
  }, [cwd, onCwdMissing])

  useEffect(() => {
    refresh()
    if (!cwd) return
    // Push-based: main watches the repo's HEAD and emits on checkout,
    // covering `git switch` in a terminal pane. The old 5s subprocess poll
    // stays only as a slow fallback for what fs.watch can miss (network
    // mounts, watcher errors).
    let disposed = false
    const api = window.api.git
    api.watchHead?.(cwd).catch((err) => log.warn('watch-head register failed, falling back to poll', err))
    const offHeadChanged = api.onHeadChanged?.((changed) => {
      if (!disposed && changed === cwd) refresh()
    })
    const timer = setInterval(() => { if (!document.hidden) refresh() }, 60_000)
    return () => {
      disposed = true
      offHeadChanged?.()
      api.unwatchHead?.(cwd).catch((err) => log.warn('unwatch-head failed (watcher may linger)', err))
      clearInterval(timer)
    }
  }, [refresh, cwd])

  const inputRef = useRef<HTMLInputElement | null>(null)

  if (!cwd || !isGitRepo) return null

  const close = (changed: boolean) => {
    setOpen(false)
    if (changed) {
      refresh()
      onChanged?.()
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch branch"
          className="inline-flex cursor-pointer items-center gap-[4px] rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[8px] py-[3px] text-[11px] text-[var(--text-secondary)] outline-none"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span className="max-w-[140px] truncate">
            {current ?? '(detached)'}
          </span>
          <span className="text-[9px] opacity-60">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label="Switch branch"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
        className="sb-floating-surface z-[1200] w-[320px] overflow-hidden rounded-[6px] border border-[var(--border)] shadow-[0_10px_30px_rgba(0,0,0,0.35)]!"
      >
        <BranchPickerPopover
          cwd={cwd}
          inputRef={inputRef}
          onSwapWorktree={onSwapWorktree}
          onClose={close}
          followSessionId={followSessionId}
          onTurnFollowBackOn={onTurnFollowBackOn}
        />
      </PopoverContent>
    </Popover>
  )
}

interface PopoverProps {
  cwd: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onSwapWorktree?: (newCwd: string, branch: string) => void
  onClose: (changed: boolean) => void
  followSessionId?: string
  onTurnFollowBackOn?: () => void
}

function BranchPickerPopover({ cwd, inputRef, onSwapWorktree, onClose, followSessionId, onTurnFollowBackOn }: PopoverProps) {
  const [refs, setRefs] = useState<Ref[]>([])
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

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

  const [followOff, setFollowOff] = useState(false)
  useEffect(() => {
    if (!followSessionId) return
    let cancelled = false
    window.api.app.getConversationFollowSuggestions(followSessionId).then(
      (res) => { if (!cancelled) setFollowOff(followSuggestionsOff(res.mode, res.workedWorktrees)) },
      (err: unknown) => log.warn('could not read the Follow suggestion setting', err),
    )
    return () => {
      cancelled = true
    }
  }, [followSessionId])

  const filtered = rankAndFilterRefs(refs, query)
  const notGitRepo = !!error && /not a git repository/i.test(error)

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
        // No git command - the picked branch already lives in another
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

  // Escape and outside clicks are the popover's; the list keys stay here.
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
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
        className="w-full border-0 border-b border-[var(--border)] bg-transparent px-[12px] py-[8px] text-[12px] text-[var(--text-primary)] outline-none"
      />
      <div role="listbox" aria-label="Branches" className="max-h-[280px] overflow-y-auto">
        {loading && <div className={emptyRowClass}>Loading…</div>}
        {!loading && error && (
          <div className={cn(emptyRowClass, !notGitRepo && 'text-[var(--accent-red,#f88)]')}>
            {notGitRepo ? 'Not a git repository.' : error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className={emptyRowClass}>No branches match "{query}"</div>
        )}
        {!loading && !error && filtered.map((ref, i) => (
          <button
            key={`${ref.isRemote ? 'r' : 'l'}:${ref.name}`}
            type="button"
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => select(ref)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-[8px] border-0 px-[12px] py-[6px] text-left text-[12px] text-[var(--text-primary)]',
              i === activeIdx ? 'bg-[var(--bg-active,var(--bg-tertiary))]' : 'bg-transparent',
              switching && switching !== ref.name && 'opacity-50',
            )}
            disabled={switching !== null && switching !== ref.name}
            role="option"
            aria-selected={i === activeIdx}
          >
            <span className="flex-1 truncate">
              <span className={ref.current ? 'font-[600]' : 'font-[400]'}>{ref.name}</span>
            </span>
            {ref.current && <span className={tagClass}>current</span>}
            {ref.isRemote && <span className={tagClass}>remote</span>}
            {ref.worktreePath && !ref.current && <span className={tagClass}>worktree</span>}
          </button>
        ))}
      </div>
      {followOff && onTurnFollowBackOn && (
        <button
          type="button"
          // Enter here is this button's, not the branch list's.
          onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation() }}
          onClick={() => {
            onTurnFollowBackOn()
            onClose(false)
          }}
          className="w-full cursor-pointer border-0 border-t border-[var(--border)] bg-transparent px-[12px] py-[7px] text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-active,var(--bg-tertiary))]"
        >
          Turn Follow suggestions back on
        </button>
      )}
    </div>
  )
}

const emptyRowClass = 'px-[12px] py-[10px] text-[12px] italic text-[var(--text-muted)]'
const tagClass = 'text-[9.5px] uppercase tracking-[0.5px] text-[var(--text-muted)]'
