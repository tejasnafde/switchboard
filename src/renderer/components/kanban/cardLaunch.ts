/**
 * Helpers for launching a chat from a kanban card. Pure derivation +
 * one orchestration function (`launchCardChat`) so the launch policy
 * doesn't drift between the background "▶" path, the foreground
 * "▶ + open" path, and the auto-kickoff on `withWorktree=true` create.
 */
import type { KanbanCard } from '@shared/kanban'
import { useAgentStore } from '../../stores/agent-store'
import { emitSessionCreated } from '../../services/session-events'
import { generateTitle } from '@shared/auto-title'

export interface CardLaunchInit {
  /** Parent project path — used for sidebar grouping (must match a
   *  registered Project.path). Do NOT substitute the worktree here, or
   *  the resulting session won't appear under any project. */
  projectPath: string
  /** Working directory the agent process runs in. Worktree if present,
   *  otherwise the parent project. */
  cwd: string
  title: string
}

export function deriveCardLaunch(card: KanbanCard): CardLaunchInit {
  return {
    projectPath: card.projectPath,
    cwd: card.worktreePath ?? card.projectPath,
    title: card.title,
  }
}

export function buildKanbanFirstTurn(card: KanbanCard): string {
  const title = card.title.trim()
  const desc = card.description.trim()
  if (title && desc) return `${title}\n\n${desc}`
  if (title) return title
  if (desc) return desc
  return 'Start working on this card.'
}

export interface LaunchOptions {
  /** Switch the renderer to the chat view after launch. False = stay on
   *  the kanban board (the "background" play button). */
  openChat: boolean
}

export interface LaunchResult {
  sessionId: string
  /** True when an existing linked conversation was reused; false when a
   *  brand-new session was started (so the caller can decide whether to
   *  also move the card to in_progress). */
  reused: boolean
}

/**
 * End-to-end launch: register the session under the parent project,
 * persist a conversation row, fire `provider.startSession` with the
 * worktree as cwd (so the agent process actually runs against the
 * isolated checkout), and auto-send the first turn built from the
 * card's title/description. Idempotent on already-linked cards.
 */
export async function launchCardChat(
  card: KanbanCard,
  opts: LaunchOptions,
): Promise<LaunchResult> {
  const log = (msg: string, data?: Record<string, unknown>) => {
    // Renderer log: structured prefix so a future log-shipper can split
    // these out. Currently goes to devtools console; main-side logs in
    // app.ts cover the IPC half of the journey.
    console.info(`[kanban:launch] ${msg}`, data ?? {})
  }

  // 1. Reuse existing session if the card is already linked. Done-column
  //    cards have their conversation archived; unarchive first so it
  //    isn't filtered out of scans / sidebar after resume.
  if (card.conversationId) {
    window.api.app
      .unarchiveConversation(card.conversationId)
      .catch((err: unknown) => log('unarchive failed', { err: String(err) }))
    const existing = useAgentStore
      .getState()
      .sessions.find((s) => s.id === card.conversationId)
    if (existing) {
      log('reuse existing session', { cardId: card.id, sessionId: existing.id })
      useAgentStore.getState().setActiveSession(existing.id)
      return { sessionId: existing.id, reused: true }
    }
  }

  const { projectPath, cwd, title } = deriveCardLaunch(card)
  const sessionId = `agent_${Date.now()}`
  const firstTurn = buildKanbanFirstTurn(card)
  log('starting new session', {
    cardId: card.id,
    sessionId,
    projectPath,
    cwd,
    openChat: opts.openChat,
  })

  // 2. Register in the renderer store under the PARENT project so the
  //    sidebar groups it correctly. The worktree is only used as cwd
  //    for the agent process below.
  useAgentStore.getState().addSession({
    id: sessionId,
    type: 'claude-code',
    status: 'running',
    projectPath,
    title,
  })
  useAgentStore.getState().setActiveSession(sessionId)

  // 3. Persist the conversation row + link to the card. Fire-and-forget
  //    on the IPC; failures are logged but don't block the agent.
  const api = window.api
  api.app
    .createConversation({ id: sessionId, projectPath, agentType: 'claude-code', title })
    .catch((err: unknown) => log('createConversation failed', { err: String(err) }))

  emitSessionCreated({
    id: sessionId,
    projectPath,
    title,
    startedAt: Date.now(),
    source: 'switchboard',
  })

  await api.kanban
    .update(card.id, { conversationId: sessionId })
    .catch((err: unknown) => log('card link failed', { err: String(err) }))

  // 4. Persist the user-message row so a reload reproduces the kickoff.
  const userMsgId = `user_${Date.now()}`
  api.app
    .saveMessage({
      id: userMsgId,
      conversationId: sessionId,
      role: 'user',
      content: firstTurn,
    })
    .catch((err: unknown) => log('saveMessage failed', { err: String(err) }))

  // 5. Update the title in DB if we just generated one from the message.
  const generatedTitle = generateTitle(firstTurn)
  if (generatedTitle && generatedTitle !== title) {
    api.app
      .renameConversation(sessionId, generatedTitle)
      .catch((err: unknown) => log('renameConversation failed', { err: String(err) }))
  }

  // 6. Spin up the provider. cwd = worktree-or-parent. Failures here
  //    surface as a system message in the chat, not a thrown error,
  //    because the session is already registered and the user can retry.
  try {
    await api.provider.startSession({
      threadId: sessionId,
      provider: 'claude',
      cwd,
      runtimeMode: 'sandbox',
    })
  } catch (err) {
    log('startSession failed', { err: String(err) })
    useAgentStore.getState().updateStatus(sessionId, 'error')
    return { sessionId, reused: false }
  }

  // 7. Auto-send the first turn — this is the whole point of "▶". The
  //    user already declared intent by clicking play; no draft step.
  api.provider
    .sendTurn(sessionId, firstTurn, 'sandbox')
    .catch((err: unknown) => log('sendTurn failed', { err: String(err) }))

  log('launched', { sessionId, cardId: card.id })
  return { sessionId, reused: false }
}
