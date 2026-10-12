/**
 * Open a quote chip's source chat through the sidebar path. A chat that is
 * not loaded lives on the machine of the chat the chip sits in; a probe of
 * its metadata tells a deleted chat apart before anything is added. Pure
 * apart from `deps`, so the rules are testable without a renderer.
 */
import { toAgentProvider, type SessionSummary } from '@shared/types'
import { PILL_OPEN_SUPERSEDED } from './pill-message-open'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:pill-open')

interface OpenSession {
  id: string
  machineId?: string
  projectPath?: string
  type?: string
  title?: string
}

export interface ChatMeta {
  projectPath: string
  agentType: string
  title: string
}

export interface PillChatOpenerDeps {
  sessions: () => readonly OpenSession[]
  bindRoute: (conversationId: string, machineId: string) => void
  unbindRoute: (conversationId: string) => void
  /** The chat's metadata, or null when the backend has no such chat. */
  probeMeta: (conversationId: string) => Promise<ChatMeta | null>
  /** The sidebar open (`handleSessionSelect`). */
  openSession: (session: SessionSummary, projectPath: string, machineId: string) => Promise<void>
  focusedId: () => string | null
  /** The newest chat-open ticket; any sidebar open takes a new one. */
  latestOpenTicket: () => number
}

/**
 * Resolves to the focused chat after the open, null when the chat is gone,
 * or PILL_OPEN_SUPERSEDED when a newer chip open (`isCurrent`) or a manual
 * navigation happened during the probe. A superseded open does not switch chat.
 */
export async function openPillSourceChat(
  conversationId: string,
  hostSessionId: string | null,
  isCurrent: () => boolean,
  deps: PillChatOpenerDeps,
): Promise<string | null | typeof PILL_OPEN_SUPERSEDED> {
  const sessions = deps.sessions()
  const open = sessions.find((session) => session.id === conversationId)
  const machineId = open?.machineId ?? sessions.find((s) => s.id === hostSessionId)?.machineId ?? 'local'
  let projectPath = open?.projectPath ?? ''
  let agentType = open?.type
  let title = open?.title ?? ''
  if (!open) {
    const ticket = deps.latestOpenTicket()
    const focused = deps.focusedId()
    const bound = machineId !== 'local'
    if (bound) deps.bindRoute(conversationId, machineId)
    // Drop the route this open made, unless something else loaded the chat meanwhile.
    const unbind = () => {
      if (bound && !deps.sessions().some((s) => s.id === conversationId)) deps.unbindRoute(conversationId)
    }
    let meta: ChatMeta | null
    try {
      meta = await deps.probeMeta(conversationId)
    } catch (err) {
      log.warn('probing the chip source chat failed', { conversationId, err })
      unbind()
      return null
    }
    if (!isCurrent() || deps.latestOpenTicket() !== ticket || deps.focusedId() !== focused) {
      unbind()
      return PILL_OPEN_SUPERSEDED
    }
    if (!meta) {
      unbind()
      return null
    }
    projectPath = meta.projectPath
    agentType = meta.agentType
    title = meta.title
  }
  const provider = toAgentProvider(agentType)
  await deps.openSession(
    { id: conversationId, source: provider, title, startedAt: 0, messageCount: 0, filePath: '', agentType: provider },
    projectPath,
    machineId,
  )
  return deps.focusedId()
}
