/**
 * Container for the right-pane "Files" mode (toggled via ⌘⇧E).
 *
 * Layout: left = directory tree, right = viewer, split by a draggable
 * handle. The split is persisted via layout-store so reopening the pane
 * restores the user's preferred ratio. Min/max widths keep the tree
 * usable even at extremes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileTreePane } from './FileTreePane'
import { FileViewerPane } from './FileViewerPane'
import { useLayoutStore } from '../../stores/layout-store'

const TREE_MIN = 140
const TREE_MAX = 600
const TREE_DEFAULT = 240
const STORAGE_KEY = 'files.treeWidth'

function loadStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const n = raw ? parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n >= TREE_MIN && n <= TREE_MAX) return n
  } catch { /* no-op */ }
  return TREE_DEFAULT
}

export function FilesPane(): React.ReactElement {
  const [treeWidth, setTreeWidth] = useState<number>(() => loadStoredWidth())
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const collapsed = useLayoutStore((s) => s.fileTreeCollapsed)
  const toggleCollapsed = useLayoutStore((s) => s.toggleFileTreeCollapsed)

  // Persist width changes (debounced via the natural ondrag cadence)
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, String(treeWidth)) } catch { /* no-op */ }
  }, [treeWidth])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const next = Math.max(TREE_MIN, Math.min(TREE_MAX, e.clientX - rect.left))
    setTreeWidth(next)
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }, [])

  return (
    <div ref={containerRef} style={{ display: 'flex', width: '100%', height: '100%' }}>
      {!collapsed && (
        <>
          <div
            style={{
              flex: `0 0 ${treeWidth}px`,
              minWidth: 0,
              overflow: 'hidden',
              borderRight: '1px solid var(--border)',
              position: 'relative',
            }}
          >
            <button
              type="button"
              onClick={toggleCollapsed}
              title="Hide file tree"
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                zIndex: 5,
                width: 18,
                height: 18,
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 11,
                lineHeight: 1,
                borderRadius: 3,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              ◀
            </button>
            <FileTreePane />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              flex: '0 0 4px',
              cursor: 'col-resize',
              background: 'transparent',
              transition: 'background 120ms',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--border)' }}
            onMouseLeave={(e) => {
              if (!draggingRef.current) (e.currentTarget as HTMLElement).style.background = 'transparent'
            }}
            title="Drag to resize"
          />
        </>
      )}
      <div style={{ flex: '1 1 0%', minWidth: 0, overflow: 'hidden' }}>
        <FileViewerPane />
      </div>
    </div>
  )
}
