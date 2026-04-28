import { useEffect, useState } from 'react'
import type { Workspace } from '@shared/types'
import { colorTokenForWorkspace } from './sidebar-helpers'

interface WorkspaceManagerProps {
  workspaces: Workspace[]
  onClose: () => void
  /** Refresh trigger — caller refetches workspaces from main after any mutation. */
  onMutated: () => void
}

/**
 * Bespoke modal for managing workspaces — list with rename / recolor /
 * delete. Mirrors the visual style of MergeIntoPicker. Reorder is left
 * to right-click in the sidebar (drag-reorder ships with v2).
 */
export function WorkspaceManager({ workspaces, onClose, onMutated }: WorkspaceManagerProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) { setCreating(false); return }
    try {
      await window.api.app.workspaces.create({ name })
      setNewName('')
      setCreating(false)
      onMutated()
    } catch { /* best-effort */ }
  }

  const handleRename = async (w: Workspace) => {
    const next = window.prompt('Rename workspace', w.name)
    if (next == null) return
    const trimmed = next.trim()
    if (!trimmed || trimmed === w.name) return
    await window.api.app.workspaces.rename(w.id, trimmed)
    onMutated()
  }

  const handleRecolor = async (w: Workspace) => {
    // 6 token slots + clear. Cycle through them in a tiny prompt.
    const tokens = ['var(--workspace-color-1)', 'var(--workspace-color-2)', 'var(--workspace-color-3)',
                    'var(--workspace-color-4)', 'var(--workspace-color-5)', 'var(--workspace-color-6)', null]
    const cur = tokens.indexOf(w.color as any)
    const next = tokens[(cur + 1 + tokens.length) % tokens.length]
    await window.api.app.workspaces.recolor(w.id, next as string | null)
    onMutated()
  }

  const handleDelete = async (w: Workspace) => {
    const ok = window.confirm(
      `Delete workspace "${w.name}"?\n\nProjects in this workspace will move back to Ungrouped — no chats are deleted.`
    )
    if (!ok) return
    await window.api.app.workspaces.delete(w.id)
    onMutated()
  }

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
        paddingTop: '15vh',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>Workspaces</span>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '11px',
                cursor: 'pointer',
                textTransform: 'none',
                letterSpacing: 0,
              }}
            >+ New</button>
          )}
        </div>

        {creating && (
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '6px' }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void handleCreate() }
                if (e.key === 'Escape') { e.preventDefault(); setNewName(''); setCreating(false) }
              }}
              placeholder="Workspace name…"
              style={{
                flex: 1,
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '5px 8px',
                color: 'var(--text-primary)',
                fontSize: '12px',
                outline: 'none',
                fontFamily: 'var(--font-sans)',
              }}
            />
            <button
              onClick={() => void handleCreate()}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >Create</button>
          </div>
        )}

        <div style={{ overflowY: 'auto', padding: '4px 0' }}>
          {workspaces.length === 0 && !creating ? (
            <div style={{ padding: '20px 16px', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>
              No workspaces yet. Create one to start organizing projects.
            </div>
          ) : (
            workspaces.map((w) => (
              <div
                key={w.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 14px',
                }}
              >
                <span style={{
                  width: '4px',
                  height: '18px',
                  background: colorTokenForWorkspace(w),
                  borderRadius: '2px',
                  flexShrink: 0,
                }} />
                <span style={{
                  flex: 1,
                  color: 'var(--text-primary)',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{w.name}</span>
                <button
                  onClick={() => void handleRename(w)}
                  style={miniBtnStyle}
                  title="Rename"
                >Rename</button>
                <button
                  onClick={() => void handleRecolor(w)}
                  style={miniBtnStyle}
                  title="Cycle color"
                >Color</button>
                <button
                  onClick={() => void handleDelete(w)}
                  style={{ ...miniBtnStyle, color: 'var(--error)' }}
                  title="Delete"
                >Delete</button>
              </div>
            ))
          )}
        </div>

        <div style={{
          padding: '6px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          Esc to close · Deleting a workspace returns its projects to Ungrouped
        </div>
      </div>
    </div>
  )
}

const miniBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  padding: '3px 8px',
  borderRadius: '4px',
  fontSize: '11px',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
}
