/**
 * ConflictResolutionPanel — surfaces during execute when the planner
 * pauses on a rebase conflict.
 *
 * Reads the active conflict from `branches-store.activeConflict`. The
 * user resolves the files on disk (in their editor of choice; we
 * surface the file paths and let them click "Open in viewer" to jump
 * to the existing FileViewerPane), stages them, and clicks
 * "Continue" — that fires `RESOLVE_CONFLICT` with `'continue'` and the
 * planner runs `rebase --continue`. "Abort" cancels the whole plan.
 */

import { useBranchesStore } from '../../stores/branches-store'
import { useLayoutStore } from '../../stores/layout-store'

interface Props {
  repoPath: string
}

export function ConflictResolutionPanel({ repoPath }: Props): React.ReactElement | null {
  const slice = useBranchesStore((s) => s.byRepo[repoPath])
  const resolveConflict = useBranchesStore((s) => s.resolveConflict)
  const openInViewer = useLayoutStore((s) => s.openInViewer)

  if (!slice?.activeConflict) return null

  const { branch, conflictFiles } = slice.activeConflict

  return (
    <div
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        width: 400,
        maxHeight: '50vh',
        background: 'var(--bg-primary)',
        border: '1px solid var(--accent, #f78c2e)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(247,140,46,0.1)',
          fontWeight: 500,
          fontSize: 12,
        }}
      >
        Conflict on <span style={{ fontFamily: 'monospace' }}>{branch}</span>
      </div>
      <div style={{ padding: '10px 14px', overflowY: 'auto', flex: '1 1 0%' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          Resolve {conflictFiles.length} file(s) on disk, stage them with{' '}
          <code>git add</code>, then continue. Mergiraf-resolved hunks (if
          installed) are pre-staged and marked clean.
        </div>
        {conflictFiles.map((f) => (
          <div
            key={f}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 11,
              fontFamily: 'monospace',
              padding: '4px 0',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f}
            </span>
            <button
              type="button"
              onClick={() => openInViewer(f)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent, #5b8cff)',
                cursor: 'pointer',
                fontSize: 11,
                padding: '0 6px',
              }}
            >
              open
            </button>
          </div>
        ))}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => { void resolveConflict({ repoPath, decision: 'continue' }) }}
          style={{
            background: 'var(--accent, #5b8cff)',
            color: '#fff',
            border: '1px solid transparent',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Continue
        </button>
        <button
          type="button"
          onClick={() => { void resolveConflict({ repoPath, decision: 'abort' }) }}
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Abort plan
        </button>
      </div>
    </div>
  )
}
