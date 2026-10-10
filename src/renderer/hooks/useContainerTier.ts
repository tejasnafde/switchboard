import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * The tier an element's content width falls in, kept current with a
 * ResizeObserver. For what a CSS container query cannot reach, such as a
 * popover portalled out of the container: pass the same steps the container
 * queries use, as a pure `tierOf(width)`.
 *
 * Returns a callback ref for the container and its current tier. The first
 * reading happens in a layout effect, so the first paint already uses it.
 */
export function useContainerTier<T>(tierOf: (width: number) => T): [(element: HTMLElement | null) => void, T] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [tier, setTier] = useState<T>(() => tierOf(0))
  const tierOfRef = useRef(tierOf)
  tierOfRef.current = tierOf

  useLayoutEffect(() => {
    if (!element) return
    // Content box, the width an inline-size container query reads.
    const read = (width: number) => setTier(tierOfRef.current(width))
    read(element.getBoundingClientRect().width - horizontalPadding(element))
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) read(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  const ref = useCallback((next: HTMLElement | null) => setElement(next), [])
  return [ref, tier]
}

function horizontalPadding(element: HTMLElement): number {
  const style = getComputedStyle(element)
  return (
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0)
  )
}
