import { useEffect, useRef } from 'react'
import { useTerminalStore } from '../stores/terminal-store'
import {
  getOrCreateTerminal,
  attachToContainer,
  fitTerminal,
} from '../services/terminal-registry'

interface UseTerminalOptions {
  id: string
  sessionId: string
  cwd?: string
  initialCommand?: string
}

/**
 * Hook that attaches a terminal instance (from the registry) to a DOM container.
 * The terminal persists in the registry across React re-renders and panel toggles.
 * Only destroyed when explicitly closed via the X button.
 */
export function useTerminal({ id, sessionId, cwd, initialCommand }: UseTerminalOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const updatePaneStatus = useTerminalStore((s) => s.updatePaneStatus)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Get or create terminal — idempotent, safe for StrictMode
    getOrCreateTerminal(id, cwd, initialCommand)
    attachToContainer(id, container)

    // Listen for PTY exit
    const removeExit = window.api.terminal.onExit((ptyId, exitCode) => {
      if (ptyId === id) {
        updatePaneStatus(sessionId, id, exitCode === 0 ? 'exited' : 'error')
      }
    })

    // ResizeObserver triggers fit when container dimensions change
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitTerminal(id))
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      removeExit()
      // Do NOT destroy terminal here — it lives in the registry
    }
  }, [id, sessionId, cwd, updatePaneStatus])

  return { containerRef }
}
