/**
 * Open what a context chip points at: the file in the IDE at its lines, the
 * terminal pane it was copied from, or the chat message it quotes. A chip
 * whose source cannot be found does nothing.
 */
import type { PillChipTarget } from './pill-chip-model'
import { useLayoutStore } from '../stores/layout-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useAgentStore } from '../stores/agent-store'
import { focusTerminal } from './terminal-registry'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:pill-open')

function findPane(sessionId: string | null, paneLabel: string): { sessionId: string; paneId: string } | null {
  const { layouts } = useTerminalStore.getState()
  const order = sessionId && layouts[sessionId] ? [sessionId, ...Object.keys(layouts).filter((id) => id !== sessionId)] : Object.keys(layouts)
  for (const sid of order) {
    const pane = Object.values(layouts[sid]?.panes ?? {}).find((p) => p.label === paneLabel)
    if (pane) return { sessionId: sid, paneId: pane.id }
  }
  return null
}

function findMessageElement(sessionId: string | null, role: 'user' | 'assistant', quote: string): HTMLElement | null {
  if (!sessionId) return null
  const session = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
  const messages = session?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== role) continue
    const text = role === 'user' ? `${message.displayBody ?? ''}\n${message.content}` : message.content
    if (!text.includes(quote)) continue
    const panel = document.querySelector(`[data-chat-panel][data-session-id="${CSS.escape(sessionId)}"]`)
    return panel?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`) ?? null
  }
  return null
}

/** Open the chip's source. `sessionId` is the chat the chip sits in. Returns whether anything opened. */
export function openPillTarget(target: PillChipTarget, sessionId: string | null): boolean {
  if (target.type === 'file') {
    const range = target.startLine !== null ? { start: target.startLine, end: target.endLine ?? target.startLine } : null
    useLayoutStore.getState().openInViewer(target.path, range, sessionId)
    return true
  }
  if (target.type === 'terminal') {
    const found = findPane(sessionId, target.paneLabel)
    if (!found) {
      log.debug('chip terminal pane not found')
      return false
    }
    const layout = useLayoutStore.getState()
    if (layout.rightPaneMode !== 'terminal') layout.setRightPaneMode('terminal')
    if (!layout.terminalVisible) layout.toggleTerminal()
    useTerminalStore.getState().setActivePane(found.sessionId, found.paneId)
    requestAnimationFrame(() => focusTerminal(found.paneId))
    return true
  }
  const el = findMessageElement(sessionId, target.role, target.quote)
  if (!el) {
    log.debug('chip message not found in the loaded history')
    return false
  }
  el.scrollIntoView({ block: 'center', behavior: 'auto' })
  return true
}
