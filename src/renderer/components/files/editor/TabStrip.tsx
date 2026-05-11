/**
 * Horizontal tab strip rendered above the editor body. Each tab shows
 * the file's basename, a dirty-dot, and a close-x. Clicking the body
 * focuses the tab; clicking the x closes it (with confirm if dirty).
 *
 * Drag-to-reorder uses the same `@dnd-kit` we already pull for the
 * sidebar — keeps the bundle slim. We don't try to be clever about
 * overflow; the strip uses `overflowX: auto` so a packed strip pans
 * horizontally on hover.
 */
import { useCallback } from 'react'
import { useEditorStore } from '../../../stores/editor-store'

interface Props {
  sessionId: string | null
}

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return sep >= 0 ? path.slice(sep + 1) : path
}

// Stable empty reference so Zustand's getSnapshot never returns a fresh []
// on every call — that would trigger an infinite useSyncExternalStore loop.
const EMPTY_TABS: string[] = []

export function TabStrip({ sessionId }: Props): React.ReactElement | null {
  const tabs = useEditorStore((s) => (sessionId ? s.tabsBySession[sessionId] ?? EMPTY_TABS : EMPTY_TABS))
  const active = useEditorStore((s) => (sessionId ? s.activeBySession[sessionId] ?? null : null))
  const buffers = useEditorStore((s) => s.buffers)

  const focus = useEditorStore((s) => s.focusBuffer)
  const close = useEditorStore((s) => s.closeBuffer)

  const onClose = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const buf = buffers[id]
      if (!buf) return
      if (buf.dirty) {
        const ok = window.confirm(`Discard unsaved changes to ${basename(buf.path)}?`)
        if (!ok) return
        close(id, { force: true })
      } else {
        close(id)
      }
    },
    [buffers, close],
  )

  if (!sessionId || tabs.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 28,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        overflowX: 'auto',
        overflowY: 'hidden',
        flexShrink: 0,
      }}
    >
      {tabs.map((id) => {
        const buf = buffers[id]
        if (!buf) return null
        const isActive = id === active
        return (
          <div
            key={id}
            onClick={() => focus(id)}
            title={buf.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 10px',
              borderRight: '1px solid var(--border)',
              background: isActive ? 'var(--bg-primary)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 11,
              minWidth: 80,
              maxWidth: 200,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {basename(buf.path)}
            </span>
            {buf.dirty && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--text-secondary)',
                  flexShrink: 0,
                }}
                aria-label="unsaved"
              />
            )}
            <button
              type="button"
              onClick={(e) => onClose(id, e)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '0 2px',
                fontSize: 12,
                lineHeight: 1,
                flexShrink: 0,
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
