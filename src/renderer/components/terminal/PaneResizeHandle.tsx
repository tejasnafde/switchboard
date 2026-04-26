import { useRef, useEffect } from 'react'

interface PaneResizeHandleProps {
  direction?: 'row' | 'column'
  onResize: (deltaPx: number) => void
  onResizeEnd: () => void
}

/**
 * Resize handle between terminal panes / windows.
 *
 * Uses pointer capture (reliable even if cursor leaves the window).
 * Callbacks held in refs so parent re-renders don't tear down mid-drag.
 */
export function PaneResizeHandle({ direction = 'row', onResize, onResizeEnd }: PaneResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  const lastPosRef = useRef(0)
  const rafRef = useRef(0)
  const activePointerRef = useRef<number | null>(null)

  // Keep latest callbacks in refs so the main effect is stable
  const onResizeRef = useRef(onResize)
  const onResizeEndRef = useRef(onResizeEnd)
  useEffect(() => { onResizeRef.current = onResize })
  useEffect(() => { onResizeEndRef.current = onResizeEnd })

  const isColumn = direction === 'column'

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return

    const resetStyle = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (handleRef.current) handleRef.current.dataset.active = ''
    }

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      try { handle.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      activePointerRef.current = e.pointerId
      lastPosRef.current = isColumn ? e.clientX : e.clientY
      handle.dataset.active = '1'
      document.body.style.cursor = isColumn ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    }

    const onPointerMove = (e: PointerEvent) => {
      if (activePointerRef.current !== e.pointerId) return
      const pos = isColumn ? e.clientX : e.clientY
      const delta = pos - lastPosRef.current
      lastPosRef.current = pos
      if (delta === 0) return
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => onResizeRef.current(delta))
    }

    const endDrag = (e?: PointerEvent) => {
      if (activePointerRef.current === null) return
      if (e && e.pointerId !== activePointerRef.current) return
      try { handle.releasePointerCapture(activePointerRef.current) } catch { /* ignore */ }
      activePointerRef.current = null
      cancelAnimationFrame(rafRef.current)
      resetStyle()
      try { onResizeEndRef.current() } catch { /* ignore */ }
    }

    const onPointerUp = (e: PointerEvent) => endDrag(e)
    const onPointerCancel = (e: PointerEvent) => endDrag(e)
    const onBlur = () => endDrag()

    handle.addEventListener('pointerdown', onPointerDown)
    handle.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', onPointerUp)
    handle.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('blur', onBlur)

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown)
      handle.removeEventListener('pointermove', onPointerMove)
      handle.removeEventListener('pointerup', onPointerUp)
      handle.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', onBlur)
      // If unmounted mid-drag, clean up so cursor/overlay don't stick
      if (activePointerRef.current !== null) {
        activePointerRef.current = null
        cancelAnimationFrame(rafRef.current)
        resetStyle()
      }
    }
  }, [isColumn])

  const style: React.CSSProperties = isColumn
    ? {
        width: '1px',
        cursor: 'col-resize',
        background: 'var(--border)',
        flexShrink: 0,
        touchAction: 'none',
        position: 'relative',
        zIndex: 5,
        transition: 'background 0.12s ease',
      }
    : {
        height: '1px',
        cursor: 'row-resize',
        background: 'var(--border)',
        flexShrink: 0,
        touchAction: 'none',
        position: 'relative',
        zIndex: 5,
        transition: 'background 0.12s ease',
      }

  const hitArea: React.CSSProperties = isColumn
    ? { position: 'absolute', top: 0, bottom: 0, left: '-4px', width: '9px' }
    : { position: 'absolute', left: 0, right: 0, top: '-4px', height: '9px' }

  return (
    <div ref={handleRef} className="pane-resize-handle" data-direction={direction} style={style}>
      <div style={hitArea} />
    </div>
  )
}
