import { useRef, useEffect, type RefObject } from 'react'

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical'
  /** Ref to the element BEFORE the handle (left/top) */
  beforeRef: RefObject<HTMLDivElement | null>
  /** Ref to the element AFTER the handle (right/bottom) — optional for flex:1 panels */
  afterRef?: RefObject<HTMLDivElement | null>
  /** CSS property to manipulate */
  prop?: 'width' | 'height'
  /** If true, dragging increases the AFTER panel (for right-side panels) */
  invert?: boolean
  /** Min size in px for the panel being resized */
  min?: number
  /** Max size in px */
  max?: number
  /** Called with final px value when drag ends */
  onResizeEnd?: (sizePx: number) => void
  /** Called on every frame during drag — use for fit triggers */
  onResizing?: () => void
  /** Show/hide the handle */
  visible?: boolean
}

/**
 * Unified drag-to-resize handle. Uses pointer capture for reliable tracking.
 * Callbacks held in refs so parent re-renders don't tear down mid-drag.
 */
export function ResizeHandle({
  direction,
  beforeRef,
  afterRef,
  prop = direction === 'horizontal' ? 'width' : 'height',
  invert = false,
  min = 100,
  max = 9999,
  onResizeEnd,
  onResizing,
  visible = true,
}: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const activePointerRef = useRef<number | null>(null)
  const isHorizontal = direction === 'horizontal'

  // Hold callbacks + refs in stable refs so the effect is deps-light
  const cfgRef = useRef({
    beforeRef, afterRef, prop, invert, min, max, isHorizontal,
    onResizeEnd, onResizing,
  })
  useEffect(() => {
    cfgRef.current = { beforeRef, afterRef, prop, invert, min, max, isHorizontal, onResizeEnd, onResizing }
  })

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return

    let startPos = 0
    let startSize = 0

    const resetStyle = () => {
      const { beforeRef: b, afterRef: a } = cfgRef.current
      if (b.current) b.current.style.pointerEvents = ''
      if (a?.current) a.current.style.pointerEvents = ''
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (handleRef.current) handleRef.current.dataset.active = ''
    }

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const { beforeRef: b, afterRef: a, invert: inv, prop: p, isHorizontal: h } = cfgRef.current
      const target = inv ? a?.current : b.current
      if (!target) return

      try { handle.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      activePointerRef.current = e.pointerId
      handle.dataset.active = '1'

      startPos = h ? e.clientX : e.clientY
      startSize = target.getBoundingClientRect()[p]

      if (b.current) b.current.style.pointerEvents = 'none'
      if (a?.current) a.current.style.pointerEvents = 'none'
      document.body.style.cursor = h ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    }

    const onPointerMove = (e: PointerEvent) => {
      if (activePointerRef.current !== e.pointerId) return
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        const { beforeRef: b, afterRef: a, invert: inv, prop: p, isHorizontal: h, min: mn, max: mx, onResizing: onR } = cfgRef.current
        const target = inv ? a?.current : b.current
        if (!target) return
        const currentPos = h ? e.clientX : e.clientY
        const delta = inv ? (startPos - currentPos) : (currentPos - startPos)
        const newSize = Math.max(mn, Math.min(mx, startSize + delta))
        target.style[p] = `${newSize}px`
        onR?.()
      })
    }

    const endDrag = (e?: PointerEvent) => {
      if (activePointerRef.current === null) return
      if (e && e.pointerId !== activePointerRef.current) return
      try { handle.releasePointerCapture(activePointerRef.current) } catch { /* ignore */ }
      activePointerRef.current = null
      cancelAnimationFrame(rafRef.current)
      resetStyle()

      const { beforeRef: b, afterRef: a, invert: inv, prop: p, onResizeEnd: onE } = cfgRef.current
      const target = inv ? a?.current : b.current
      if (target && onE) {
        const finalSize = target.getBoundingClientRect()[p]
        onE(finalSize)
      }
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
      if (activePointerRef.current !== null) {
        activePointerRef.current = null
        cancelAnimationFrame(rafRef.current)
        resetStyle()
      }
    }
  }, [])

  if (!visible) return null

  return (
    <div
      ref={handleRef}
      className="split-divider"
      style={{
        [isHorizontal ? 'width' : 'height']: '4px',
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        background: 'var(--border)',
        flexShrink: 0,
        touchAction: 'none',
        position: 'relative',
        zIndex: 10,
      }}
    >
      {/* Expanded hit target — transparent background so it's still
          hit-testable by pointer events (empty divs without background
          can be no-op in some renderers). */}
      <div
        style={{
          position: 'absolute',
          inset: isHorizontal ? '0 -4px 0 -4px' : '-4px 0 -4px 0',
          background: 'transparent',
          pointerEvents: 'auto',
        }}
      />
    </div>
  )
}
