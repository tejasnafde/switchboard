/**
 * WorktreeManagerModal - manual oversight + cleanup for git worktrees.
 *
 * Lists every worktree git knows about under the current project, plus a
 * "stale" subset that cleanup will target by default. A worktree is stale
 * when (a) git itself marks it prunable, (b) the directory is missing on
 * disk, or (c) no durable owner references it. Owned worktrees must be
 * removed through their conversation/card action so immutable identity is checked.
 *
 * We deliberately don't auto-clean on launch: deleting a worktree drops
 * uncommitted work, so the user always pulls the trigger themselves.
 */

import { useCallback, useEffect, useState } from 'react'
import type { WorktreeInfo } from '@shared/kanban'
import { createRendererLogger } from '../../logger'
import { confirm } from '../ui/confirm'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { cn } from '../../lib/utils'
import { closeButtonClass, dangerButtonClass, footerClass, headerClass, modalClass, secondaryButtonClass } from './kanban-modal-classes'

const log = createRendererLogger('kanban:worktree-manager')

interface Props {
  projectPath: string
  onClose: () => void
}

export function WorktreeManagerModal({ projectPath, onClose }: Props): React.ReactElement {
  const [all, setAll] = useState<WorktreeInfo[]>([])
  const [stale, setStale] = useState<WorktreeInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = window.api?.kanban
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const [a, s] = await Promise.all([
        api.listWorktrees(projectPath),
        api.listStaleWorktrees(projectPath),
      ])
      setAll(a)
      setStale(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setHasLoadedOnce(true)
    }
  }, [projectPath])

  useEffect(() => { void refresh() }, [refresh])

  const removeOne = async (wt: WorktreeInfo, _force: boolean) => {
    const api = window.api?.kanban
    if (!api) return
    if (wt.inUse) {
      setError('This worktree is owned. Remove it from its conversation or card so cleanup uses canonical identity.')
      return
    }
    setBusy(wt.path)
    setError(null)
    try {
      await api.removeStaleWorktree(projectPath, wt.path, { force: true })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const cleanupAllStale = async () => {
    const api = window.api?.kanban
    if (!api) return
    if (stale.length === 0) return
    if (!(await confirm({
      title: `Remove ${stale.length} stale worktree${stale.length === 1 ? '' : 's'}?`,
      body: 'Uncommitted work will be lost.',
      confirmLabel: 'Remove',
      destructive: true,
    }))) return
    setBusy('__all__')
    setError(null)
    try {
      for (const wt of stale) {
        try {
          await api.removeStaleWorktree(projectPath, wt.path, { force: true })
        } catch (err) {
          log.warn('failed to remove', wt.path, err)
        }
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        overlayClassName="z-[1000] bg-[rgba(0,0,0,0.4)]"
        className={modalClass('w-[640px] max-w-[94vw]')}
      >
        <div className={headerClass}>
          <DialogTitle className="text-[13px] font-[600]">Worktrees - {projectPath.split('/').pop()}</DialogTitle>
          <button onClick={onClose} className={closeButtonClass} aria-label="Close">&times;</button>
        </div>

        <div className="flex flex-col gap-[6px] overflow-auto p-[12px]">
          {error && <div className="p-[6px] text-[12px] text-[var(--red,#d73a49)]">{error}</div>}

          <div className="mt-[4px] flex items-center gap-[8px] text-[11px] font-[600] uppercase tracking-[0.4px] opacity-[0.85]">
            <span>All ({all.length})</span>
            {loading && <Spinner />}
          </div>
          {/* Skeleton on first load only; subsequent refreshes dim the prior list instead. */}
          {!hasLoadedOnce && loading && (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}
          {hasLoadedOnce && all.length === 0 && (
            <div className="p-[12px] text-center text-[12px] opacity-60">No worktrees under this project.</div>
          )}
          <div className={cn('flex flex-col gap-[6px] transition-opacity duration-[120ms]', loading && hasLoadedOnce && 'opacity-60')}>
            {all.map((wt) => (
              <div key={wt.path} className={rowClass} data-stale={!isInList(wt, stale) ? undefined : true}>
                <div className={rowMainClass}>
                  <div className="truncate text-[12px] [font-family:monospace]">{wt.path.replace(projectPath, '.')}</div>
                  <div className="flex flex-wrap gap-[4px]">
                    {wt.branch && <span className={cn(chipClass, 'bg-[rgba(0,0,0,0.06)]')}>⎇ {wt.branch}</span>}
                    <span className={cn(chipClass, 'bg-[rgba(0,0,0,0.06)]')}>{wt.head.slice(0, 7)}</span>
                    {wt.inUse
                      ? <span className={cn(chipClass, 'bg-[rgba(46,160,67,0.15)] text-[var(--green,#2ea043)]')}>linked</span>
                      : <span className={cn(chipClass, 'opacity-[0.55]')}>orphaned</span>}
                    {wt.prunable && <span className={cn(chipClass, chipWarnClass)}>prunable</span>}
                    {isInList(wt, stale) && <span className={cn(chipClass, chipWarnClass)}>stale</span>}
                  </div>
                </div>
                <button
                  onClick={() => void removeOne(wt, false)}
                  disabled={busy !== null || loading || wt.inUse}
                  title={wt.inUse ? 'Remove this worktree from its owning conversation or card.' : 'Remove orphaned worktree'}
                  className={dangerButtonClass}
                >
                  {busy === wt.path ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className={footerClass}>
          <button onClick={() => void refresh()} disabled={loading || busy !== null} className={secondaryButtonClass}>
            Refresh
          </button>
          <div className="flex-1" />
          <button
            onClick={() => void cleanupAllStale()}
            disabled={stale.length === 0 || busy !== null}
            className={dangerButtonClass}
          >
            Clean up {stale.length} stale {busy === '__all__' && '…'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function isInList(wt: WorktreeInfo, list: WorktreeInfo[]): boolean {
  return list.some((x) => x.path === wt.path)
}

function Spinner(): React.ReactElement {
  return (
    <span
      aria-label="Loading"
      className="inline-block size-[12px] animate-[sb-spin_720ms_linear_infinite] rounded-full border-2 border-[var(--border)] border-t-[var(--accent,#2563eb)]"
    />
  )
}

function SkeletonRow(): React.ReactElement {
  const bar = 'rounded-[3px] bg-[rgba(0,0,0,0.08)]'
  return (
    <div className={cn(rowClass, 'pointer-events-none animate-[sb-pulse_1200ms_ease-in-out_infinite]')}>
      <div className={rowMainClass}>
        <div className={cn(bar, 'h-[11px] w-[55%]')} />
        <div className={cn(bar, 'mt-[4px] h-[9px] w-[35%]')} />
      </div>
      <div className="h-[22px] w-[64px] rounded-[4px] bg-[rgba(0,0,0,0.08)]" />
    </div>
  )
}

const rowClass = 'flex items-center gap-[8px] rounded-[4px] border border-[var(--border)] bg-transparent p-[8px]'
const rowMainClass = 'flex min-w-0 flex-1 flex-col gap-[4px]'
const chipClass = 'rounded-[8px] px-[6px] py-[1px] text-[10px] [font-family:monospace]'
const chipWarnClass = 'bg-[rgba(215,58,73,0.15)] text-[var(--red,#d73a49)]'
