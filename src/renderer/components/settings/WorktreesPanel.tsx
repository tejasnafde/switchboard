/**
 * The worktree manager: Settings > Archive & data > Worktrees, and the body
 * of the kanban board's worktree dialog (scoped to one project there).
 *
 * Marks only the exceptions. A clean worktree is plain muted text, one with
 * changes is amber with an icon, one in use has a lock and a disabled
 * checkbox. Only worktrees that lose nothing can be ticked for a batch; one
 * with changes is removed on its own after a confirm naming what goes, and
 * the backend re-checks that against fresh git state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  WORKTREE_FILTERS,
  classifyWorktree,
  filterCounts,
  formatBytes,
  gitStateLabel,
  removalConfirmBody,
  type WorktreeFilter,
  type WorktreeInventory,
  type WorktreeRow,
} from '@shared/worktree-manager'
import { createRendererLogger } from '../../logger'
import { confirm } from '../ui/confirm'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import {
  canBatchRemove,
  protectedNote,
  pruneSelection,
  removeButtonLabel,
  visibleRows,
} from './worktree-list'

const log = createRendererLogger('settings:worktrees')

export interface WorktreeInventoryState {
  inventory: WorktreeInventory | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

/** One inventory load, shared by the summary row and the manager so git is read once. */
export function useWorktreeInventory(projectPaths?: string[]): WorktreeInventoryState {
  const [inventory, setInventory] = useState<WorktreeInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = projectPaths?.join('\n')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setInventory(await window.api.worktreeManager.inventory(key === undefined ? undefined : key.split('\n')))
    } catch (err) {
      log.warn('worktree inventory failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [key])

  useEffect(() => { void reload() }, [reload])
  return { inventory, loading, error, reload }
}

/** Sizes load per row after the list renders, one request each; the backend caches and throttles them. */
function useWorktreeSizes(rows: readonly WorktreeRow[]): Map<string, number | null> {
  const [sizes, setSizes] = useState<Map<string, number | null>>(() => new Map())
  const requested = useRef(new Set<string>())
  useEffect(() => {
    for (const row of rows) {
      if (row.prunable || requested.current.has(row.path)) continue
      requested.current.add(row.path)
      window.api.worktreeManager.size(row.path)
        .then(({ bytes }) => setSizes((prev) => new Map(prev).set(row.path, bytes)))
        .catch((err) => {
          log.warn('worktree size failed', row.path, err)
          setSizes((prev) => new Map(prev).set(row.path, null))
        })
    }
  }, [rows])
  return sizes
}

export function WorktreesPanel({ state, onManageProtection }: {
  state: WorktreeInventoryState
  /** Opens wherever project protection is managed. Absent: the note has no link. */
  onManageProtection?: () => void
}) {
  const { inventory, loading, error, reload } = state
  const rows = useMemo(() => inventory?.rows ?? [], [inventory])
  const [filter, setFilter] = useState<WorktreeFilter>('all')
  const [showProtected, setShowProtected] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const sizes = useWorktreeSizes(rows)
  const counts = useMemo(() => filterCounts(rows), [rows])
  const shown = useMemo(() => visibleRows(rows, filter, showProtected), [rows, filter, showProtected])
  const note = useMemo(() => protectedNote(rows), [rows])

  useEffect(() => { setSelected((prev) => pruneSelection(prev, rows)) }, [rows])

  const toggle = (path: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const removeRows = async (targets: WorktreeRow[], acknowledge: boolean) => {
    setBusy(true)
    setActionError(null)
    const failures: string[] = []
    for (const row of targets) {
      try {
        const result = await window.api.worktreeManager.remove({
          projectPath: row.projectPath,
          worktreePath: row.path,
          acknowledged: acknowledge && row.git
            ? { uncommittedFiles: row.git.uncommittedFiles, unpushedCommits: row.git.unpushedCommits }
            : null,
        })
        if (!result.ok) failures.push(`${row.branch ?? row.path}: ${result.error}`)
      } catch (err) {
        log.warn('worktree remove failed', row.path, err)
        failures.push(`${row.branch ?? row.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (failures.length > 0) setActionError(failures.join('\n'))
    setBusy(false)
    await reload()
  }

  const removeSelected = async () => {
    const targets = rows.filter((row) => selected.has(row.path))
    if (targets.length === 0) return
    const n = targets.length
    if (!(await confirm({
      title: `Remove ${n} worktree${n === 1 ? '' : 's'}?`,
      body: `${n === 1 ? 'It is' : 'Each is'} clean with nothing unpushed, so no work is lost. The folders are removed with git worktree remove.`,
      confirmLabel: 'Remove',
    }))) return
    await removeRows(targets, false)
  }

  const removeWithChanges = async (row: WorktreeRow) => {
    if (!(await confirm({
      title: `Remove ${row.branch ?? 'this worktree'}?`,
      body: removalConfirmBody(row),
      // Unpushed commits on a branch survive; only uncommitted files, or a detached HEAD's commits, are lost.
      confirmLabel: row.git?.uncommittedFiles || !row.branch ? 'Remove and lose changes' : 'Remove worktree',
      destructive: true,
    }))) return
    await removeRows([row], true)
  }

  const setWorktreeProtected = async (row: WorktreeRow, on: boolean) => {
    setActionError(null)
    try {
      await window.api.worktreeManager.setProtection({ target: 'worktree', path: row.path, protected: on })
    } catch (err) {
      log.warn('worktree protect failed', row.path, err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
    await reload()
  }

  return (
    <div className="@container">
      <div role="toolbar" aria-label="Filter worktrees" className="mb-3 flex gap-[18px] border-b border-[var(--border)]">
        {WORKTREE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              '-mb-px cursor-pointer whitespace-nowrap border-0 border-b-2 border-solid bg-transparent px-0 pb-2 pt-1.5 text-[13px] outline-none focus-visible:text-[var(--text-primary)]',
              filter === f.id
                ? 'border-b-[var(--accent)] text-[var(--text-primary)]'
                : 'border-b-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {f.label}
            <span className={cn('ml-[5px] tabular-nums', filter === f.id ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]')}>
              {counts[f.id]}
            </span>
          </button>
        ))}
      </div>

      {(error || actionError) && (
        <div role="alert" className="mb-2 whitespace-pre-line text-[12px] text-[var(--error)]">{error ?? actionError}</div>
      )}
      {inventory?.errors.map((e) => (
        <div key={e.projectPath} className="mb-2 text-[12px] text-[var(--warning)]">Could not list {e.projectPath}: {e.message}</div>
      ))}

      <div className={cn('overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] transition-opacity', loading && inventory && 'opacity-60')}>
        <div className={cn(gridClass, 'text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]')}>
          <span />
          <span>Project / branch</span>
          <span className={chatColClass}>Chat</span>
          <span>Git</span>
          <span className="text-right">Size</span>
          <span />
        </div>
        {!inventory && loading && <div className={emptyClass}>Reading worktrees…</div>}
        {inventory && shown.length === 0 && (
          <div className={emptyClass}>{rows.length === 0 ? 'No worktrees.' : 'Nothing under this filter.'}</div>
        )}
        {shown.map((row) => (
          <WorktreeListRow
            key={row.path}
            row={row}
            checked={selected.has(row.path)}
            size={sizes.get(row.path)}
            disabled={busy}
            onToggle={() => toggle(row.path)}
            onRemove={() => void removeWithChanges(row)}
            onProtect={(on) => void setWorktreeProtected(row, on)}
          />
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
          {note && (
            <>
              <LockIcon />
              {note}
              <button type="button" onClick={() => setShowProtected((v) => !v)} className={linkClass}>
                {showProtected ? 'Hide' : 'Show'}
              </button>
              {onManageProtection && <button type="button" onClick={onManageProtection} className={linkClass}>Manage</button>}
            </>
          )}
        </span>
        <span className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading || busy}>Refresh</Button>
          {selected.size > 0 && <span className="text-[12px] tabular-nums text-[var(--text-secondary)]">{selected.size} selected</span>}
          <Button size="sm" onClick={() => void removeSelected()} disabled={selected.size === 0 || busy || loading}>
            {busy ? 'Removing…' : selected.size > 0 ? removeButtonLabel(selected, sizes) : 'Remove'}
          </Button>
        </span>
      </div>
    </div>
  )
}

function WorktreeListRow({ row, checked, size, disabled, onToggle, onRemove, onProtect }: {
  row: WorktreeRow
  checked: boolean
  size: number | null | undefined
  disabled: boolean
  onToggle: () => void
  onRemove: () => void
  onProtect: (on: boolean) => void
}) {
  const category = classifyWorktree(row)
  const state = gitStateLabel(row)
  const branch = row.branch ?? `detached at ${row.head.slice(0, 7)}`
  const batchable = canBatchRemove(row)
  return (
    <div data-worktree-row={category} className={cn(gridClass, 'group border-t border-[var(--border)] text-[12.5px]')}>
      <input
        type="checkbox"
        aria-label={`Select ${branch}`}
        checked={checked}
        disabled={!batchable || disabled}
        onChange={onToggle}
        title={batchable ? undefined : category === 'has_changes' ? 'Has changes; remove it on its own' : state.title}
        className="m-0 size-[14px] accent-[var(--accent)] disabled:opacity-30"
      />
      <span className="min-w-0" title={`${branch}\n${row.path}`}>
        <span className="block truncate font-[600]">{row.projectName}</span>
        <span className="block truncate text-[var(--text-secondary)]">{branch}</span>
      </span>
      <span className={cn(chatColClass, 'min-w-0 truncate text-[var(--text-secondary)]')} title={row.chat?.title}>
        {row.chat ? `${row.chat.title}${row.chat.archived ? ' · archived' : ''}` : 'none'}
      </span>
      <span
        title={state.title}
        className={cn(
          'inline-flex min-w-0 items-center gap-[5px] text-[12px]',
          state.tone === 'warn' ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]',
        )}
      >
        {state.tone === 'warn' && <WarnIcon />}
        {state.tone === 'lock' && <LockIcon />}
        <span className="truncate">{state.text}</span>
      </span>
      <span className="text-right tabular-nums text-[var(--text-secondary)]">
        {row.prunable ? '-' : size === undefined ? '…' : size === null ? '-' : formatBytes(size)}
      </span>
      <span className="flex justify-end gap-1">
        {category === 'has_changes' && row.git && (
          <button type="button" disabled={disabled} onClick={onRemove} className={rowActionClass}>Remove…</button>
        )}
        {category === 'protected' && row.protectedBy === 'worktree' && (
          <button type="button" disabled={disabled} onClick={() => onProtect(false)} className={rowActionClass}>Unprotect</button>
        )}
        {(category === 'safe' || category === 'has_changes') && (
          <button
            type="button"
            disabled={disabled}
            aria-label={`Protect ${branch}`}
            title="Protect: never offered for cleanup"
            onClick={() => onProtect(true)}
            className={cn(rowActionClass, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
          >
            <LockIcon />
          </button>
        )}
      </span>
    </div>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  )
}

// Six columns; under 620px of panel width the Chat column goes.
const gridClass = 'grid grid-cols-[20px_1.7fr_1fr_1.2fr_72px_84px] items-center gap-2.5 px-[14px] py-[9px] first:border-t-0 @max-[620px]:grid-cols-[20px_1.6fr_1.4fr_64px_84px]'
const chatColClass = '@max-[620px]:hidden'
const emptyClass = 'border-t border-[var(--border)] px-[14px] py-3 text-[12.5px] text-[var(--text-secondary)]'
const linkClass = 'cursor-pointer border-0 bg-transparent p-0 text-[12px] text-[var(--accent)] outline-none hover:underline focus-visible:underline'
const rowActionClass = 'inline-flex cursor-pointer items-center rounded-[4px] border-0 bg-transparent px-1 py-0.5 text-[11.5px] text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40'
