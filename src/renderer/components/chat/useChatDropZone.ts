import { useEffect, useRef, useState, type RefObject } from 'react'

const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

/**
 * Makes the whole chat view around `inner` (the nearest `[data-chat-panel]`)
 * a drop target for files. Returns that view, to portal the overlay into, and
 * whether a file drag is over it. The state also clears on the window's
 * `dragend` and `drop`, because a drag cancelled with Escape does not always
 * send `dragleave`.
 */
export function useChatDropZone(
  inner: RefObject<HTMLElement | null>,
  onDrop: (e: DragEvent) => void,
): { panel: HTMLElement | null; dragging: boolean } {
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    setPanel(inner.current?.closest<HTMLElement>('[data-chat-panel]') ?? inner.current)
  }, [inner])

  useEffect(() => {
    if (!panel) return
    let depth = 0
    const reset = (): void => {
      depth = 0
      setDragging(false)
    }
    const enter = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth += 1
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      depth -= 1
      if (depth <= 0) reset()
    }
    const drop = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      reset()
      onDropRef.current(e)
    }
    panel.addEventListener('dragenter', enter)
    panel.addEventListener('dragover', over)
    panel.addEventListener('dragleave', leave)
    panel.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      panel.removeEventListener('dragenter', enter)
      panel.removeEventListener('dragover', over)
      panel.removeEventListener('dragleave', leave)
      panel.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [panel])

  return { panel, dragging }
}
