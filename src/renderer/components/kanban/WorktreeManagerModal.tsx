/**
 * WorktreeManagerModal — manual oversight + cleanup for git worktrees.
 *
 * Lists every worktree git knows about under the current project, plus a
 * "stale" subset that cleanup will target by default. A worktree is stale
 * when (a) git itself marks it prunable, (b) the directory is missing on
 * disk, or (c) no kanban card references it. The user can also force-
 * remove an in-use worktree from here — useful when a card is wedged.
 *
 * We deliberately don't auto-clean on launch: deleting a worktree drops
 * uncommitted work, so the user always pulls the trigger themselves.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { WorktreeInfo } from '@shared/kanban'

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const removeOne = async (wt: WorktreeInfo, force: boolean) => {
    const api = window.api?.kanban
    if (!api) return
    if (wt.inUse && !force) {
      if (!confirm(`Worktree "${wt.path}" is linked to a kanban card. Remove anyway?`)) return
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
    if (!confirm(`Remove ${stale.length} stale worktree${stale.length === 1 ? '' : 's'}? Uncommitted work will be lost.`)) return
    setBusy('__all__')
    setError(null)
    try {
      for (const wt of stale) {
        try {
          await api.removeStaleWorktree(projectPath, wt.path, { force: true })
        } catch (err) {
          console.warn('[worktree-manager] failed to remove', wt.path, err)
        }
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span>Worktrees — {projectPath.split('/').pop()}</span>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        <div style={bodyStyle}>
          {error && <div style={errStyle}>{error}</div>}

          <div style={sectionTitleStyle}>
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
            <div style={emptyStyle}>No worktrees under this project.</div>
          )}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            opacity: loading && hasLoadedOnce ? 0.6 : 1,
            transition: 'opacity 120ms',
          }}>
            {all.map((wt) => (
              <div key={wt.path} style={rowStyle} data-stale={!isInList(wt, stale) ? undefined : true}>
                <div style={rowMainStyle}>
                  <div style={pathStyle}>{wt.path.replace(projectPath, '.')}</div>
                  <div style={rowMetaStyle}>
                    {wt.branch && <span style={chipStyle}>⎇ {wt.branch}</span>}
                    <span style={chipStyle}>{wt.head.slice(0, 7)}</span>
                    {wt.inUse ? <span style={chipOkStyle}>linked</span> : <span style={chipMutedStyle}>orphaned</span>}
                    {wt.prunable && <span style={chipWarnStyle}>prunable</span>}
                    {isInList(wt, stale) && <span style={chipWarnStyle}>stale</span>}
                  </div>
                </div>
                <button
                  onClick={() => void removeOne(wt, false)}
                  disabled={busy !== null || loading}
                  style={dangerBtnStyle}
                >
                  {busy === wt.path ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={footerStyle}>
          <button onClick={() => void refresh()} disabled={loading || busy !== null} style={secondaryBtnStyle}>
            Refresh
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => void cleanupAllStale()}
            disabled={stale.length === 0 || busy !== null}
            style={dangerBtnStyle}
          >
            Clean up {stale.length} stale {busy === '__all__' && '…'}
          </button>
        </div>
      </div>
    </div>
  )
}

function isInList(wt: WorktreeInfo, list: WorktreeInfo[]): boolean {
  return list.some((x) => x.path === wt.path)
}

function Spinner(): React.ReactElement {
  return (
    <span
      aria-label="Loading"
      style={{
        display: 'inline-block',
        width: 12, height: 12,
        border: '2px solid var(--border)',
        borderTopColor: 'var(--accent, #2563eb)',
        borderRadius: '50%',
        animation: 'sb-spin 720ms linear infinite',
      }}
    />
  )
}

function SkeletonRow(): React.ReactElement {
  return (
    <div style={{
      ...rowStyle,
      animation: 'sb-pulse 1200ms ease-in-out infinite',
      pointerEvents: 'none',
    }}>
      <div style={rowMainStyle}>
        <div style={{ height: 11, width: '55%', background: 'var(--bg-elev2, rgba(0,0,0,0.08))', borderRadius: 3 }} />
        <div style={{ height: 9, width: '35%', background: 'var(--bg-elev2, rgba(0,0,0,0.08))', borderRadius: 3, marginTop: 4 }} />
      </div>
      <div style={{ width: 64, height: 22, background: 'var(--bg-elev2, rgba(0,0,0,0.08))', borderRadius: 4 }} />
    </div>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const modalStyle: CSSProperties = {
  width: 640, maxWidth: '94vw', maxHeight: '88vh',
  background: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 8,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
}
const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 600,
}
const closeBtnStyle: CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--fg)', cursor: 'pointer', fontSize: 14,
}
const bodyStyle: CSSProperties = { padding: 12, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }
const sectionTitleStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 11, fontWeight: 600, opacity: 0.85,
  textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4,
}
const emptyStyle: CSSProperties = { fontSize: 12, opacity: 0.6, padding: 12, textAlign: 'center' }
const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: 8, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev1, transparent)',
}
const rowMainStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }
const pathStyle: CSSProperties = { fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const rowMetaStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const chipBaseStyle: CSSProperties = { fontSize: 10, padding: '1px 6px', borderRadius: 8, fontFamily: 'monospace' }
const chipStyle: CSSProperties = { ...chipBaseStyle, background: 'var(--bg-elev2, rgba(0,0,0,0.06))' }
const chipOkStyle: CSSProperties = { ...chipBaseStyle, background: 'rgba(46,160,67,0.15)', color: 'var(--green, #2ea043)' }
const chipMutedStyle: CSSProperties = { ...chipBaseStyle, opacity: 0.55 }
const chipWarnStyle: CSSProperties = { ...chipBaseStyle, background: 'rgba(215,58,73,0.15)', color: 'var(--red, #d73a49)' }
const errStyle: CSSProperties = { color: 'var(--red, #d73a49)', fontSize: 12, padding: 6 }
const footerStyle: CSSProperties = {
  display: 'flex', gap: 6, padding: 10, borderTop: '1px solid var(--border)',
}
const secondaryBtnStyle: CSSProperties = {
  fontSize: 12, padding: '6px 14px', background: 'transparent', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
}
const dangerBtnStyle: CSSProperties = {
  fontSize: 12, padding: '6px 14px', background: 'transparent', color: 'var(--red, #d73a49)',
  border: '1px solid var(--red, #d73a49)', borderRadius: 4, cursor: 'pointer',
}
