import { useState, useEffect, useCallback, useMemo } from 'react'
import { emitSessionRename } from '../../services/session-events'
import { selectArchivedPage, type ArchivedRow } from './archived-list'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:archived')

/** Settings > Archive & data: archived conversations, searchable and paged. */
export function ArchivedPanel() {
  const [archived, setArchived] = useState<ArchivedRow[]>([])
  const [loadingArchived, setLoadingArchived] = useState(false)
  const [archivedQuery, setArchivedQuery] = useState('')
  const [archivedPageNum, setArchivedPageNum] = useState(1)

  const loadArchived = useCallback(async () => {
    setLoadingArchived(true)
    try {
      const rows = await window.api.app.getArchivedConversations()
      setArchived(rows ?? [])
      setArchivedPageNum(1)
    } catch (err) {
      log.warn('could not load archived conversations', err)
      setArchived([])
    } finally {
      setLoadingArchived(false)
    }
  }, [])

  useEffect(() => { void loadArchived() }, [loadArchived])

  const archivedView = useMemo(
    () => selectArchivedPage(archived, archivedQuery, archivedPageNum),
    [archived, archivedQuery, archivedPageNum],
  )

  const handleUnarchive = useCallback(async (conv: ArchivedRow) => {
    setArchived((prev) => prev.filter((c) => c.id !== conv.id))
    try {
      await window.api.app.unarchiveConversation(conv.id)
      // Trigger sidebar refresh via rename event (same title - just to nudge the list)
      emitSessionRename(conv.id, conv.title)
      // Also dispatch a generic event to prompt project reload
      window.dispatchEvent(new CustomEvent('sidebar-refresh'))
    } catch (err) {
      // Re-sort on the backend's key: appending would put the row last, and
      // with paging, on a different page than the one it was clicked on.
      log.warn('unarchive failed, restoring the row', err)
      setArchived((prev) => [...prev, conv].sort((a, b) => b.updated_at - a.updated_at))
    }
  }, [])

  return (
    <>
      {loadingArchived ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
      ) : archived.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          No archived conversations. Archive a chat from the sidebar to see it here.
        </div>
      ) : (
        <>
          <input
            value={archivedQuery}
            onChange={(e) => { setArchivedQuery(e.target.value); setArchivedPageNum(1) }}
            placeholder={`Search ${archived.length} archived chat${archived.length === 1 ? '' : 's'} by title or project...`}
            style={{
              width: '100%',
              marginBottom: '8px',
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontSize: '12px',
              outline: 'none',
            }}
          />
          {/* Above the list on purpose. A full page of rows can be taller
              than the window, so a pager underneath them sits below the
              fold and has to be scrolled to. */}
          {archivedView.total > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginBottom: '8px',
            }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                Showing {archivedView.from} to {archivedView.to} of {archivedView.total}
              </span>
              {archivedView.pageCount > 1 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setArchivedPageNum(archivedView.page - 1)}
                    disabled={archivedView.page <= 1}
                    style={pagerButtonStyle(archivedView.page <= 1)}
                  >
                    Previous
                  </button>
                  <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                    Page {archivedView.page} of {archivedView.pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setArchivedPageNum(archivedView.page + 1)}
                    disabled={archivedView.page >= archivedView.pageCount}
                    style={pagerButtonStyle(archivedView.page >= archivedView.pageCount)}
                  >
                    Next
                  </button>
                </span>
              )}
            </div>
          )}
          {archivedView.total === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 0' }}>
              No matches for "{archivedQuery.trim()}".
            </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {archivedView.items.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 500,
                  }}>
                    {c.title}
                  </div>
                  <div style={{
                    fontSize: '10px',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }} title={c.project_path}>
                    {c.project_path.split('/').slice(-2).join('/')}
                  </div>
                </div>
                <button
                  onClick={() => handleUnarchive(c)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--accent)',
                    background: 'var(--accent-subtle)',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                >
                  Unarchive
                </button>
              </div>
            ))}
          </div>
          )}
                  </>
                )}
    </>
  )
}

function pagerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '3px 9px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
    fontSize: '11px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
}
