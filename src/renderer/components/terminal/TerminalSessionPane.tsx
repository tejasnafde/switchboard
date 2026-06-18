/**
 * TerminalSessionPane — full-height terminal for sessions with type='terminal'.
 * Replaces the chat panel in the center column when a terminal session is active.
 */
import { useEffect, useRef } from 'react'
import { attachToContainer, fitTerminal } from '../../services/terminal-registry'

interface Props {
  paneId: string
}

export function TerminalSessionPane({ paneId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    attachToContainer(paneId, containerRef.current)

    const ro = new ResizeObserver(() => fitTerminal(paneId))
    ro.observe(containerRef.current)
    // Don't kill PTY on unmount — pane survives panel toggles, same as TerminalPane.
    return () => ro.disconnect()
  }, [paneId])

  return (
    <div
      ref={containerRef}
      data-terminal-pane={paneId}
      style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
    />
  )
}
