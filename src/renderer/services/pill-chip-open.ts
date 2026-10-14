/**
 * Open what a context chip points at, the chip viewer's "Go to source": the
 * file in the IDE at its lines, the terminal pane it was copied from, the
 * chat message it quotes (opening that chat first when it is another one), or
 * the pull request in Reviews. An open that does not land resolves to false,
 * and the viewer then says its text is the copy that was sent.
 */
import type { PillChipTarget } from './pill-chip-model'
import { useLayoutStore } from '../stores/layout-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useAgentStore } from '../stores/agent-store'
import { useReviewStore } from '../stores/review-store'
import { prKey } from '@shared/pull-requests'
import { focusTerminal } from './terminal-registry'
import { ensureFullHistory } from './history-loader'
import { resolvePillMessage, PILL_OPEN_SUPERSEDED } from './pill-message-open'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:pill-open')

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

/**
 * The viewer's "Go to source" button text, or null when the source does not
 * resolve: a terminal chip only while its pane exists, a quote in another
 * chat named after that chat when it is loaded. `sessionId` is the chat the
 * chip sits in.
 */
export function pillSourceAction(target: PillChipTarget | null, sessionId: string | null): string | null {
  if (!target) return null
  if (target.type === 'terminal') return findPane(sessionId, target.paneLabel) ? 'Open pane' : null
  if (target.type === 'file') return 'Open in editor'
  if (target.type === 'review') return 'Open in Reviews'
  const other = target.source?.conversationId
  if (!other || other === sessionId) return 'Show in chat'
  const title = useAgentStore
    .getState()
    .sessions.find((s) => s.id === other)
    ?.title?.trim()
  return title ? `Show in \u201c${title}\u201d` : 'Show in chat'
}

/** The pull request a review chip names: same number, and the same repository when the chip knows it. */
function openReview(target: Extract<PillChipTarget, { type: 'review' }>): boolean {
  const reviews = useReviewStore.getState()
  const repo = target.repo?.toLowerCase()
  const matches = (reviews.list?.prs ?? []).filter(
    (pr) => pr.ref.number === target.number && (!repo || `${pr.ref.owner}/${pr.ref.name}`.toLowerCase() === repo),
  )
  // Two repositories with the same number and no repository on the chip: show the list, pick none.
  if (matches.length === 1) reviews.select(prKey(matches[0].ref))
  else log.debug('chip pull request not in the list', { matches: matches.length })
  useLayoutStore.getState().setAppView('reviews')
  return true
}

async function openMessage(
  target: Extract<PillChipTarget, { type: 'message' }>,
  hostSessionId: string | null,
): Promise<boolean> {
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
    return true
  }
  if (resolution.status !== 'superseded') {
    log.info('chip message source not found', { reason: resolution.status, hasSource: target.source !== null })
  }
  return false
}

/** Open the chip's source. `sessionId` is the chat the chip sits in. */
export async function openPillTarget(target: PillChipTarget, sessionId: string | null): Promise<boolean> {
  if (target.type === 'message') return openMessage(target, sessionId)
  openTicket++
  if (target.type === 'review') return openReview(target)
  if (target.type === 'file') {
    const range =
      target.startLine !== null ? { start: target.startLine, end: target.endLine ?? target.startLine } : null
    useLayoutStore.getState().openInViewer(target.path, range, sessionId)
    return true
  }
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
