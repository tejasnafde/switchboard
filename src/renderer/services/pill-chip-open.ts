/**
 * Open what a context chip points at: the file in the IDE at its lines, the
 * terminal pane it was copied from, or the chat message it quotes (opening
 * that chat first when it is another one). A message that is gone comes back
 * as a notice for the chip's card.
 */
import type { PillChipTarget } from './pill-chip-model'
import { useLayoutStore } from '../stores/layout-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useAgentStore } from '../stores/agent-store'
import { focusTerminal } from './terminal-registry'
import { ensureFullHistory } from './history-loader'
import { resolvePillMessage, PILL_OPEN_SUPERSEDED } from './pill-message-open'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:pill-open')

export const MESSAGE_GONE_NOTICE = 'Message no longer in this chat'
export const CHAT_GONE_NOTICE = 'Chat no longer available'

/** `notice` is what the chip's card says when the source could not be opened. */
export type PillOpenResult = { opened: true } | { opened: false; notice: string | null }

/**
 * Opens a chat the sidebar way (remote chats on their own machine); resolves
 * to the focused chat, null, or PILL_OPEN_SUPERSEDED once `isCurrent` is false
 * or the user navigated away.
 */
type PillChatOpener = (
  conversationId: string,
  hostSessionId: string | null,
  isCurrent: () => boolean,
) => Promise<string | null | typeof PILL_OPEN_SUPERSEDED>
let chatOpener: PillChatOpener | null = null

export function registerPillChatOpener(fn: PillChatOpener | null): void {
  chatOpener = fn
}

/** Bumped by every open, so a slow message open never scrolls after a newer one. */
let openTicket = 0

function findPane(sessionId: string | null, paneLabel: string): { sessionId: string; paneId: string } | null {
  const { layouts } = useTerminalStore.getState()
  const order =
    sessionId && layouts[sessionId]
      ? [sessionId, ...Object.keys(layouts).filter((id) => id !== sessionId)]
      : Object.keys(layouts)
  for (const sid of order) {
    const pane = Object.values(layouts[sid]?.panes ?? {}).find((p) => p.label === paneLabel)
    if (pane) return { sessionId: sid, paneId: pane.id }
  }
  return null
}

/** Whether the chip's card offers to open it: a terminal chip only while its pane exists. */
export function canOpenPillTarget(target: PillChipTarget | null, sessionId: string | null): boolean {
  if (!target) return false
  if (target.type === 'terminal') return findPane(sessionId, target.paneLabel) !== null
  return true
}

async function openMessage(
  target: Extract<PillChipTarget, { type: 'message' }>,
  hostSessionId: string | null,
): Promise<PillOpenResult> {
  const ticket = ++openTicket
  const isCurrent = () => ticket === openTicket
  const resolution = await resolvePillMessage(target, hostSessionId, {
    focusedId: () => useLayoutStore.getState().focusedChatSessionId(),
    sessionMessages: (id) => useAgentStore.getState().sessions.find((s) => s.id === id)?.messages,
    openChat: async (conversationId) => {
      if (!chatOpener) return null
      try {
        return await chatOpener(conversationId, hostSessionId, isCurrent)
      } catch (err) {
        log.warn('opening the chip source chat failed', err)
        return null
      }
    },
    ensureFullHistory,
    isCurrent,
  })
  if (resolution.status === 'found') {
    useAgentStore.getState().requestScrollToMessage(resolution.sessionId, resolution.messageId)
    return { opened: true }
  }
  if (resolution.status === 'superseded') return { opened: false, notice: null }
  log.info('chip message source not found', { reason: resolution.status, hasSource: target.source !== null })
  return { opened: false, notice: resolution.status === 'chat-missing' ? CHAT_GONE_NOTICE : MESSAGE_GONE_NOTICE }
}

/** Open the chip's source. `sessionId` is the chat the chip sits in. */
export async function openPillTarget(target: PillChipTarget, sessionId: string | null): Promise<PillOpenResult> {
  if (target.type === 'message') return openMessage(target, sessionId)
  openTicket++
  if (target.type === 'file') {
    const range =
      target.startLine !== null ? { start: target.startLine, end: target.endLine ?? target.startLine } : null
    useLayoutStore.getState().openInViewer(target.path, range, sessionId)
    return { opened: true }
  }
  const found = findPane(sessionId, target.paneLabel)
  if (!found) {
    log.debug('chip terminal pane not found')
    return { opened: false, notice: null }
  }
  const layout = useLayoutStore.getState()
  if (layout.rightPaneMode !== 'terminal') layout.setRightPaneMode('terminal')
  if (!layout.terminalVisible) layout.toggleTerminal()
  useTerminalStore.getState().setActivePane(found.sessionId, found.paneId)
  requestAnimationFrame(() => focusTerminal(found.paneId))
  return { opened: true }
}
