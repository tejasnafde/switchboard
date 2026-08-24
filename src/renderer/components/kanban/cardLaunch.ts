/**
 * Helpers for launching a chat from a kanban card. Pure derivation +
 * one orchestration function (`launchCardChat`) so the launch policy
 * doesn't drift between the background "▶" path, the foreground
 * "▶ + open" path, and the auto-kickoff on `withWorktree=true` create.
 */
import { createRendererLogger } from '../../logger'
import type { KanbanCard } from '@shared/kanban'
import { KANBAN_DEFAULT_RUNTIME_MODE } from '@shared/kanban'
import { useAgentStore, getStoreDefaultRuntimeMode, type RuntimeMode } from '../../stores/agent-store'
import { emitSessionCreated } from '../../services/session-events'
import type { AgentType, ConversationRow } from '@shared/types'

const launchLog = createRendererLogger('kanban:launch')

const VALID_MODES: ReadonlySet<RuntimeMode> = new Set([
  'plan', 'sandbox', 'accept-edits', 'full-access',
])

/**
 * Resolve the runtime mode for a card-launched chat. Order of precedence:
 *   1. Explicit per-card mode (`card.runtimeMode`) - the user's intent
 *      from the create modal; only honored on NEW launches.
 *   2. Per-conversation persisted mode (from `conversations.runtime_mode`)
 *      - checked for reused launches; reflects any mid-conversation mode
 *      changes the user made after the initial launch.
 *   3. The user's last-chosen default this session
 *      (`getStoreDefaultRuntimeMode()`), seeded from settings at boot.
 *   4. `KANBAN_DEFAULT_RUNTIME_MODE` ('accept-edits') as the final
 *      fallback - matches the kanban-create-modal default.
 *
 * `cardRuntimeMode` is the strongest signal, but we still consult the DB
 * before it on the reuse path so a stored override (e.g. user toggled to
 * full-access mid-turn) survives reopening through the play button.
 *
 * Exported so it's directly unit-testable.
 */
export async function resolveCardRuntimeMode(
  cardRuntimeMode: RuntimeMode | null | undefined,
  conversationId: string | null | undefined,
): Promise<RuntimeMode> {
  if (conversationId) {
    try {
      const res = await window.api?.app?.getConversationRuntimeMode?.(conversationId)
      const persisted = res?.mode
      if (persisted && VALID_MODES.has(persisted as RuntimeMode)) {
        return persisted as RuntimeMode
      }
    } catch { /* fall through */ }
  }
  if (cardRuntimeMode && VALID_MODES.has(cardRuntimeMode)) return cardRuntimeMode
  return getStoreDefaultRuntimeMode() ?? KANBAN_DEFAULT_RUNTIME_MODE
}

export interface CardLaunchInit {
  /** Parent project path - used for sidebar grouping (must match a
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
    launchLog.info(msg, data ?? {})
  }

  // 1. Reuse existing session if the card is already linked. Done-column
  //    cards have their conversation archived; unarchive first so it
  //    isn't filtered out of scans / sidebar after resume.
  if (card.conversationId) {
    window.api.app
      .unarchiveConversation(card.conversationId)
      .catch((err: unknown) => log('unarchive failed', { err: String(err) }))
    let existing = useAgentStore
      .getState()
      .sessions.find((s) => s.id === card.conversationId)
    if (!existing) {
      const rows = await window.api.app.getConversations(card.projectPath) as ConversationRow[]
      const row = rows.find((candidate) => candidate.id === card.conversationId)
      if (!row) {
        throw new Error('The linked conversation is not available. Refresh the board to recover its creation state.')
      }
      const agentType: AgentType = row.agent_type === 'codex' || row.agent_type === 'opencode'
        ? row.agent_type
        : 'claude-code'
      useAgentStore.getState().addSession({
        id: row.id,
        type: agentType,
        status: 'idle',
        projectPath: row.project_path,
        title: row.title,
        runtimeMode: card.runtimeMode,
        worktreePath: row.worktree_path ?? card.worktreePath,
        worktreeBranch: row.worktree_branch ?? card.worktreeBranch,
      })
      existing = useAgentStore.getState().sessions.find((session) => session.id === row.id)
    }
    if (existing) {
      log('reuse existing session', { cardId: card.id, sessionId: existing.id })
      useAgentStore.getState().setActiveSession(existing.id)
      // Fix up the in-memory mode and pinned model from the DB. The session
      // may have been added via a sidebar click on app boot (which seeded
      // `runtimeMode` with the module default before we could fetch the
      // persisted value, and left `model` unset entirely). Without this,
      // the chip would show e.g. 'sandbox' even though the user's last
      // selection was 'full-access', and the model picker would silently
      // drop back to the adapter default.
      //
      // The two reads are independent, fired concurrently rather than one
      // after the other - each wrapped in its own async IIFE so a
      // synchronous throw from either rejects that entry instead of
      // skipping the other fix-up.
      const [runtimeModeResult, modelResult] = await Promise.allSettled([
        (async () => resolveCardRuntimeMode(card.runtimeMode, existing.id))(),
        (async () => window.api?.app?.getConversationModel?.(existing.id))(),
      ])
      if (runtimeModeResult.status === 'fulfilled') {
        const persisted = runtimeModeResult.value
        if (persisted !== existing.runtimeMode) {
          useAgentStore.getState().setRuntimeMode(existing.id, persisted)
          window.api?.provider?.setRuntimeMode?.(existing.id, persisted).catch(() => {})
        }
      } else {
        log('runtime-mode hydrate failed', { err: String(runtimeModeResult.reason) })
      }
      if (modelResult.status === 'fulfilled') {
        const res = modelResult.value
        if (res?.model && res.model !== existing.model) {
          useAgentStore.getState().setModel(existing.id, res.model)
          window.api?.provider?.setModel?.(existing.id, res.model).catch(() => {})
        }
      } else {
        log('model hydrate failed', { err: String(modelResult.reason) })
      }
      return { sessionId: existing.id, reused: true }
    }
  }

  const { projectPath, cwd, title } = deriveCardLaunch(card)
  const sessionId = `agent_${Date.now()}`
  const firstTurn = buildKanbanFirstTurn(card)
  // Pull the real source of truth instead of hardcoding 'sandbox'. New cards
  // (no linked conversation) inherit the user's last-chosen default; reused
  // cards that lost their in-memory session pull from the DB row.
  const runtimeMode = await resolveCardRuntimeMode(card.runtimeMode, card.conversationId)
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
    runtimeMode,
  })
  useAgentStore.getState().setActiveSession(sessionId)

  // 3. Persist identity before starting the provider. Parent-checkout launches
  //    are not worktree transactions, but they still must not race provider work.
  const api = window.api
  await api.app.createConversation({ id: sessionId, projectPath, agentType: 'claude-code', title })

  emitSessionCreated({
    id: sessionId,
    projectPath,
    title,
    startedAt: Date.now(),
    source: 'switchboard',
  })

  await api.kanban.update(card.id, { conversationId: sessionId })

  // 6. Spin up the provider. cwd = worktree-or-parent. Failures here
  //    surface as a system message in the chat, not a thrown error,
  //    because the session is already registered and the user can retry.
  try {
    await api.provider.startSession({
      threadId: sessionId,
      provider: 'claude',
      cwd,
      runtimeMode,
    })
    // Persist the chosen mode against the freshly-created conversation row
    // so subsequent reopens (incl. via card click) restore it.
    api.app.setConversationRuntimeMode?.(sessionId, runtimeMode).catch(() => {})
  } catch (err) {
    log('startSession failed', { err: String(err) })
    useAgentStore.getState().updateStatus(sessionId, 'error')
    return { sessionId, reused: false }
  }

  // 7. The backend atomically persists and dispatches this stable-origin turn.
  //    A lost acknowledgement can be reconciled by replaying the same envelope.
  const submission = await api.provider.submitUserTurn({
    version: 1,
    threadId: sessionId,
    origin: `kanban:${card.id}:initial-prompt`,
    providerText: firstTurn,
    displayBody: firstTurn,
    runtimeMode,
    autoTitleText: firstTurn,
  })
  if (!submission.accepted) {
    useAgentStore.getState().updateStatus(sessionId, 'error')
    throw new Error(submission.reason)
  }

  log('launched', { sessionId, cardId: card.id })
  return { sessionId, reused: false }
}
