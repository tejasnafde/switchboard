import { create } from 'zustand'
import {
  isChatSessionDisplayed,
  removeRuntimeChatSession,
  selectRuntimeChatSession,
} from '../services/chat-workspace-runtime'
import type { AgentStatus, AgentType, ChatMessage } from '@shared/types'
import type { ReasoningEffort } from '@shared/models'
import { createRendererLogger } from '../logger'
import { mergeLiveSessions, settleSessionsNotLive, toAgentStatus, toAgentType } from './live-session-merge'
import type { LiveSessionSummary } from '@shared/live-sessions'
import { PENDING_REQUEST_EVENT_TYPES, applyPendingRequestEvent, type PendingBlockingEvent } from '@shared/pending-requests'
import type { RuntimeEvent } from '@shared/provider-events'
import { NO_QUEUED_TURNS, applyQueuedTurnEvent, queuedRowRemoved, seedQueuedTurns, type QueuedTurnsByMessage } from '@shared/queued-turns'
import type { QueuedTurnSummary } from '@shared/turn-delivery'
import type { FollowSuggestionMode } from '@shared/follow-suggestions'
import { isRuntimeMode, SETTING_DEFAULT_RUNTIME_MODE } from '@shared/session-defaults'
import { effectiveLocalSetting, projectOverride } from './project-settings-store'
import { isDraftSessionId, type DraftChatOptions } from '@shared/new-chat-draft'
import { prependOlder, rebaseOnNewest } from '../services/history-window'
import type {
  ForkLineageMetadata,
} from '@shared/conversation-fork'

const log = createRendererLogger('store:agent')

import type { RuntimeMode } from '@shared/provider-events'
export type { RuntimeMode }

/**
 * Module-level "last chosen" runtime mode used as the default seed when a
 * new session is created and the caller doesn't pass an explicit mode. This
 * is the user-visible "source of truth" for the default - it gets hydrated
 * from settings DB at app boot and updated whenever the user picks a mode
 * in any chat. Without this, every newly opened chat (sidebar new, kanban
 * card click, search-modal jump) would silently revert to 'sandbox' even
 * though the user just toggled to 'full-access' in the previous chat.
 */
let storeDefaultRuntimeMode: RuntimeMode = 'sandbox'
export function getStoreDefaultRuntimeMode(): RuntimeMode {
  return storeDefaultRuntimeMode
}
export function setStoreDefaultRuntimeMode(mode: RuntimeMode): void {
  storeDefaultRuntimeMode = mode
}

/** The mode a new chat in this project starts in: its override, else the store default. */
export function defaultRuntimeModeFor(projectPath: string | null | undefined): RuntimeMode {
  const mode = effectiveLocalSetting(SETTING_DEFAULT_RUNTIME_MODE, projectPath, storeDefaultRuntimeMode)
  return isRuntimeMode(mode) ? mode : storeDefaultRuntimeMode
}

/**
 * The one rule for a session's starting mode, applied wherever a session
 * enters the store (`addSession`, `adoptLiveSessions`), so no path can skip
 * it. `chosen` is a mode someone decided: the user, a mode carried over from
 * another chat, a card's own mode, the conversation's stored mode, or the
 * backend's live descriptor. Without one the session is unresolved: it shows
 * the renderer's default (the project override when known, else the global
 * one) only as a guess, sends no mode, and the backend's `sessionDefaultsFor`
 * decides. A renderer default is never sent as if it were a choice.
 */
export function initialRuntimeMode(
  projectPath: string | null | undefined,
  chosen: unknown,
): { runtimeMode: RuntimeMode; runtimeModeUnresolved?: true } {
  if (isRuntimeMode(chosen)) return { runtimeMode: chosen }
  return { runtimeMode: defaultRuntimeModeFor(projectPath), runtimeModeUnresolved: true }
}

/** The mode to send to the backend: none while the session's mode is unresolved, so the backend decides. */
export function runtimeModeToSend(session: Pick<AgentSession, 'runtimeMode' | 'runtimeModeUnresolved'> | undefined): RuntimeMode | undefined {
  if (!session || session.runtimeModeUnresolved) return undefined
  return session.runtimeMode
}

/** Take the mode the backend started an unresolved session in (the `startSession` reply). */
export function adoptStartedRuntimeMode(sessionId: string, started: unknown): void {
  const session = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session?.runtimeModeUnresolved) return
  const mode = (started as { runtimeMode?: unknown } | null | undefined)?.runtimeMode
  if (isRuntimeMode(mode)) useAgentStore.getState().setRuntimeMode(sessionId, mode)
  else log.warn(`startSession for ${sessionId} reported no runtime mode; the chat keeps showing its guess`)
}

/** The project's own runtime-mode override, which beats a mode carried over from another chat. */
export function projectRuntimeModeOverride(projectPath: string | null | undefined): RuntimeMode | undefined {
  const mode = projectOverride(projectPath, SETTING_DEFAULT_RUNTIME_MODE)
  return isRuntimeMode(mode) ? mode : undefined
}

export interface DriftSuggestion {
  worktreePath: string
  branch: string
  /** The conversation's Follow-chip setting, from the backend (absent = auto). */
  followSuggestions?: FollowSuggestionMode
  /** Distinct worktrees the conversation has worked in. */
  workedWorktrees?: number
}

interface AgentSession {
  id: string
  type: AgentType
  status: AgentStatus
  messages: ChatMessage[]
  /** `beforeId` of the next older history window; null or absent = all loaded. */
  olderHistoryCursor?: string | null
  conversationId?: string
  projectPath?: string
  forkMetadata?: ForkLineageMetadata
  /**
   * The machine this session runs on. Undefined / 'local' = this laptop's
   * backend; a remote machine id routes the session's provider + terminal
   * calls to that machine's WsTransport (see preload routing table).
   */
  machineId?: string
  /**
   * Absolute path to the git worktree backing this session, if it was
   * created with worktree mode. When present, this - not `projectPath` -
   * is the cwd handed to the agent adapter at start. `projectPath`
   * always points at the parent repo so the sidebar can still group
   * by project.
   */
  worktreePath?: string | null
  /** Immutable backend catalog identity for a managed worktree. */
  worktreeId?: string | null
  /** Agent wrote into a different worktree - offer to follow (worktree.drift). */
  driftSuggestion?: DriftSuggestion | null
  /**
   * The "off" notice was closed in this window. Covers a drift event computed
   * before the backend saved the dismissal; cleared once suggestions are on.
   */
  followNoticeDismissed?: boolean
  /** Branch name in `worktreePath` (e.g. `sb/thread-abc123`). */
  worktreeBranch?: string | null
  /**
   * Optimistic-concurrency token for the execution root, from the backend.
   * A relocation result or event carrying a LOWER revision than this is a
   * superseded move and must be ignored, or two clients repaint each other's
   * branch chip backwards forever.
   */
  executionRootRevision?: number
  /** Stable PTY handles already created by a backend-owned workspace transaction. */
  managedTerminalIds?: string[]
  /** Claude CLI session ID for --resume (from imported JSONL sessions) */
  resumeSessionId?: string
  /** Number of unread assistant messages (incremented when not active) */
  unreadCount: number
  /**
   * Approval/question/plan cards the backend holds open for this thread,
   * seeded from `provider.getPendingRequests` and advanced by live events.
   * Kept apart from `messages` so an unopened chat can say it needs you
   * without gaining messages, which would skip its history load.
   */
  pendingRequests?: readonly PendingBlockingEvent[]
  /**
   * Bumped by every tracked pending-request event for the thread, changed or
   * not, so a recovery can tell a live event arrived while it was waiting on
   * the backend and must not overwrite it with an older snapshot.
   */
  pendingRequestRevision?: number
  /**
   * Messages the backend holds until the running turn ends, keyed by their
   * chat row id. Seeded from `provider.listQueuedTurns`, advanced by
   * `turn.queued` / `turn.dequeued`.
   */
  queuedTurns?: QueuedTurnsByMessage
  /** Bumped by every queued-turn event, so a recovery can tell it raced one. */
  queuedTurnRevision?: number
  /** Display title (user-editable, auto-generated from first message) */
  title?: string
  /** Permission mode for this session (sandbox / accept-edits / full-access / plan) */
  runtimeMode: RuntimeMode
  /**
   * `runtimeMode` is only a guess: nobody chose it and the project's
   * overrides could not be read. The session sends no mode, so the backend
   * resolves it, and adopts the one the backend reports. Cleared by any
   * `setRuntimeMode`.
   */
  runtimeModeUnresolved?: boolean
  /** Model identifier (provider-specific - e.g. 'claude-opus-4-5' or 'gpt-5') */
  model?: string
  /**
   * Model the backend actually RESOLVED to, reported by `context_window`.
   * Distinct from `model`, which is only what the user PINNED. Never copy this
   * into `model`: that would turn a display value into a pin they never chose.
   */
  resolvedModel?: string
  /**
   * Currently selected provider-instance id (named credential set). When
   * undefined, the registry resolves to `<agentType>-default` at session
   * start. Changing this requires a session restart - handled by the
   * ChatPanel agent/instance change flow.
   */
  instanceId?: string
  /**
   * Reasoning effort tier for agents that expose it as a separate selector
   * (currently Codex only). Maps to the `reasoningEffort` param on
   * turn/start. Claude doesn't surface this as a UI control.
   */
  reasoningEffort?: ReasoningEffort
  /** PTY pane id in terminal-registry. Only set for type='terminal' sessions. */
  terminalPaneId?: string

  /**
   * Cumulative session cost in USD reported by the agent. ACP-backed
   * adapters populate this from `usage_update.cost.amount`; other adapters
   * leave it undefined. StatusBar shows it next to the context-window count.
   */
  costUsd?: number
  /**
   * Variants advertised by the agent for the currently selected model
   * (e.g. 'low' / 'medium' / 'high' / 'max'). Empty/undefined for models
   * without variants. The renderer pairs this with `currentVariant` to
   * render a thinking-budget chip group next to the model picker.
   */
  availableVariants?: string[]
  currentVariant?: string
  /**
   * Per-session context-window usage. Sourced from `turn.completed` and
   * `context_window` runtime events. Lives on the session (not on the
   * ChatPanel component) so switching sessions immediately shows the
   * correct meter value instead of leaking the previously-active panel's
   * reading until the next event fires. Both the active panel and the
   * dual-chat right-hand panel read from this slot, scoped by their own
   * session id.
   */
  tokenUsage?: { usedTokens: number; maxTokens: number | null }
  /** Present only on an unsent new chat (see shared/new-chat-draft). */
  draft?: DraftChatOptions
}

interface AgentStore {
  sessions: AgentSession[]
  activeSessionId: string | null
  /**
   * Pending "scroll to this message" request - set by SearchModal when the
   * user clicks a result, or by the Saved-bookmarks list. MessageList picks
   * it up via its subscription and tells the virtualizer to scroll to the
   * right row, then clears.
   *
   * Either `messageId` or `messageTimestamp` identifies the target. Bookmarks
   * store only the timestamp (no message id at save time), so timestamp is
   * the fallback match key. `stamp` is a re-click rerun counter.
   */
  pendingScrollToMessage:
    | { sessionId: string; messageId?: string; messageTimestamp?: number; stamp: number; query?: string }
    | null
  /**
   * Open that chat's in-pane find (cmd+F) with `query` typed in, on
   * `messageId`'s match. Set by message search (cmd+shift+F) after it opens
   * the chat; the chat panel showing the session takes it and clears it.
   */
  pendingChatFind: { sessionId: string; query: string; messageId: string; stamp: number } | null

  /** `runtimeMode` only when someone chose it; absent, the session is unresolved (`initialRuntimeMode`). */
  addSession: (session: Omit<AgentSession, 'messages' | 'unreadCount' | 'runtimeMode' | 'runtimeModeUnresolved'> & { runtimeMode?: RuntimeMode }) => void
  removeSession: (id: string) => void
  setActiveSession: (id: string) => void
  /** Clear the badge without focusing the session - a `thread.read` from
   *  another client (the phone) means it was read there, not here. */
  markSessionRead: (id: string) => void
  updateStatus: (id: string, status: AgentStatus) => void
  /** When a machine's tunnel drops the remote server dies with it - reset that
   *  machine's in-flight sessions ('running' or 'thinking') to 'idle' so they
   *  don't spin forever waiting for a turn.completed that will never come
   *  (messages untouched). */
  resetRunningSessionsForMachine: (machineId: string) => void
  /**
   * Adopt sessions running on the backend that this window did not start.
   * Without it, a chat begun on the phone has no row here, so every reducer
   * no-ops and the chat reads as idle while it streams.
   */
  adoptLiveSessions: (live: LiveSessionSummary[], machineId?: string) => void
  /** After a resume gap: idle the machine's working rows its backend no longer runs. `null` = the base backend. */
  settleSessionsNotLive: (live: LiveSessionSummary[], machineId: string | null) => void
  appendMessage: (sessionId: string, message: ChatMessage) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<ChatMessage>) => void
  removeMessage: (sessionId: string, messageId: string) => void
  /** Replace the history. `olderHistoryCursor` marks it as a newest window. */
  setMessages: (sessionId: string, messages: ChatMessage[], olderHistoryCursor?: string | null) => void
  /** Put an older window in front, only if `expectedCursor` is still current. */
  prependOlderMessages: (sessionId: string, expectedCursor: string, older: ChatMessage[], nextCursor: string | null) => boolean
  /** Replace a window whose oldest row the backend lost with its newest window, keeping live rows; only if `expectedCursor` is still current. */
  rebaseHistoryWindow: (sessionId: string, expectedCursor: string, newest: ChatMessage[], nextCursor: string | null) => boolean
  clearMessages: (sessionId: string) => void
  setConversationId: (sessionId: string, conversationId: string) => void
  setPendingRequests: (sessionId: string, pending: readonly PendingBlockingEvent[]) => void
  trackPendingRequestEvent: (event: RuntimeEvent) => void
  setQueuedTurns: (sessionId: string, turns: readonly QueuedTurnSummary[]) => void
  trackQueuedTurnEvent: (event: RuntimeEvent) => void
  getActiveSession: () => AgentSession | undefined
  setTitle: (sessionId: string, title: string) => void
  setRuntimeMode: (sessionId: string, mode: RuntimeMode) => void
  setModel: (sessionId: string, model: string) => void
  /** Record the model the backend resolved to. Does NOT change the user's pin. */
  setResolvedModel: (sessionId: string, resolvedModel: string) => void
  setReasoningEffort: (sessionId: string, effort: ReasoningEffort) => void
  setCostUsd: (sessionId: string, costUsd: number) => void
  setVariants: (sessionId: string, available: string[], current: string) => void
  setTokenUsage: (sessionId: string, usage: { usedTokens: number; maxTokens: number | null }) => void
  /**
   * Switch the agent backend (claude-code / codex / opencode) for a
   * session. Required so consumers like StatusBar - which read from the
   * store rather than the chat-panel-local `agentType` state - see the
   * change immediately. Without this, the bottom status bar lagged the
   * dropdown by a full provider round-trip.
   */
  setAgentType: (sessionId: string, type: AgentType) => void
  /**
   * Pick the provider instance for a session. Pair with a session
   * restart for the new credentials to take effect.
   */
  setInstanceId: (sessionId: string, instanceId: string | undefined) => void
  setDraftOptions: (sessionId: string, patch: Partial<DraftChatOptions>) => void
  /**
   * Switch the worktree pointer mid-session. Called when the branch
   * picker's `swap-cwd` action fires. Does NOT restart the running
   * adapter - the change applies to the next session launch (e.g. on
   * app restart) and to anything that reads `worktreePath` reactively
   * (sidebar tags, future cwd badges).
   */
  setDriftSuggestion: (sessionId: string, suggestion: DriftSuggestion | null) => void
  setFollowNoticeDismissed: (sessionId: string, dismissed: boolean) => void
  setWorktree: (
    sessionId: string,
    worktreePath: string | null,
    worktreeBranch: string | null,
  ) => void
  /**
   * Apply a root COMMITTED by the backend. Ignores a revision at or below the
   * one already held, which is what lets several clients converge.
   */
  applyExecutionRoot: (
    sessionId: string,
    root: { path: string; branch: string | null; revision: number; isWorktree: boolean },
  ) => void
  /**
   * Adopt a revision the backend reported, without moving the root.
   *
   * Used when a relocation is refused as stale: our number was wrong and the
   * refusal carried the right one, so the retry can succeed instead of
   * failing identically forever.
   */
  syncExecutionRootRevision: (sessionId: string, revision: number) => void
  requestScrollToMessage: (sessionId: string, messageId: string, query?: string) => void
  /** Bookmarks know only the timestamp at save time, so the click path uses
   *  this variant - MessageList resolves it to the message id on its end. */
  requestScrollToTimestamp: (sessionId: string, messageTimestamp: number) => void
  clearScrollToMessage: () => void
  requestChatFind: (sessionId: string, query: string, messageId: string) => void
  clearChatFind: () => void
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  pendingScrollToMessage: null,
  pendingChatFind: null,

  addSession: (session) =>
    set((state) => ({
      sessions: [
        ...state.sessions,
        {
          ...session,
          messages: [],
          unreadCount: 0,
          ...initialRuntimeMode(session.projectPath, session.runtimeMode),
        },
      ],
      activeSessionId: state.activeSessionId ?? session.id,
    })),

  removeSession: (id) => {
    // Tear down the main-process adapter session before dropping the
    // renderer state. Without this, archiving / closing a tab leaks the
    // adapter process (Codex app-server, OpenCode ACP child, Claude SDK
    // query loop) - they keep their cwd, file handles, and TCP sockets
    // until the whole Electron app exits. Fire-and-forget: if the main
    // process has already cleaned the session up (e.g. on shutdown) the
    // IPC handler is a no-op.
    if (!isDraftSessionId(id)) {
      window.api.provider?.stopSession?.(id).catch((err: unknown) => {
        log.warn(`stopSession(${id}) failed:`, err)
      })
    }
    // Drop the routing-table entry so a stale id can't keep routing to its old machine.
    window.api.routing?.unbind?.(id)
    removeRuntimeChatSession(id)
    set((state) => {
      const remaining = state.sessions.filter((s) => s.id !== id)
      return {
        sessions: remaining,
        activeSessionId:
          state.activeSessionId === id
            ? remaining[0]?.id ?? null
            : state.activeSessionId,
      }
    })
  },

  setActiveSession: (id) => {
    if (selectRuntimeChatSession(id)) return
    set((state) => ({
      activeSessionId: id,
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, unreadCount: 0 } : s
      ),
    }))
  },

  markSessionRead: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id && s.unreadCount !== 0 ? { ...s, unreadCount: 0 } : s
      ),
    })),

  updateStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status } : s
      ),
    })),

  resetRunningSessionsForMachine: (machineId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.machineId !== machineId) return s
        // The remote server died with the tunnel, and every open card with it.
        const cleared = s.pendingRequests?.length ? { ...s, pendingRequests: [] } : s
        return s.status === 'running' || s.status === 'thinking' ? { ...cleared, status: 'idle' } : cleared
      }),
    })),

  settleSessionsNotLive: (live, machineId) =>
    set((state) => ({
      sessions: settleSessionsNotLive(state.sessions, live, (s) =>
        s.type !== 'terminal' && (machineId === null ? !s.machineId || s.machineId === 'local' : s.machineId === machineId)),
    })),

  adoptLiveSessions: (live, machineId) =>
    set((state) => ({
      sessions: mergeLiveSessions<AgentSession>({
        existing: state.sessions,
        live,
        create: (s) => ({
          id: s.threadId,
          type: toAgentType(s.provider),
          status: toAgentStatus(s.status),
          messages: [],
          // History is loaded lazily when the user opens the chat. Seeding it
          // here would fetch every running thread's transcript on connect.
          projectPath: s.cwd,
          machineId,
          unreadCount: 0,
          ...initialRuntimeMode(s.cwd, s.runtimeMode),
          model: s.model,
          instanceId: s.instanceId,
          resumeSessionId: s.sessionId,
          title: s.title,
        }),
        applyStatus: (row, status) => ({ ...row, status: toAgentStatus(status) }),
      }),
    })),

  appendMessage: (sessionId, message) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s
        // Idempotent across persisted hydration, transport replay, and
        // reconnect delivery. The shared provider reducer already guarantees
        // that multiple mounted ChatPanels do not reduce an event twice.
        if (s.messages.some((m) => m.id === message.id)) return s
        return {
          ...s,
          messages: [...s.messages, message],
          unreadCount: !isChatSessionDisplayed(sessionId) && message.role === 'assistant'
            ? s.unreadCount + 1
            : s.unreadCount,
        }
      }),
    })),

  updateMessage: (sessionId, messageId, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === messageId ? { ...m, ...updates } : m
              ),
            }
          : s
      ),
    })),

  removeMessage: (sessionId, messageId) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, messages: session.messages.filter((message) => message.id !== messageId) }
          : session
      ),
    })),

  setMessages: (sessionId, messages, olderHistoryCursor = null) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages, olderHistoryCursor } : s
      ),
    })),

  prependOlderMessages: (sessionId, expectedCursor, older, nextCursor) => {
    let applied = false
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId || s.olderHistoryCursor !== expectedCursor) return s
        applied = true
        return { ...s, messages: prependOlder(s.messages, older), olderHistoryCursor: nextCursor }
      }),
    }))
    return applied
  },

  rebaseHistoryWindow: (sessionId, expectedCursor, newest, nextCursor) => {
    let applied = false
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId || s.olderHistoryCursor !== expectedCursor) return s
        const messages = rebaseOnNewest(s.messages, newest)
        if (!messages) return s
        applied = true
        return { ...s, messages, olderHistoryCursor: nextCursor }
      }),
    }))
    return applied
  },

  clearMessages: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [], olderHistoryCursor: null } : s
      ),
    })),

  setConversationId: (sessionId, conversationId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, conversationId } : s
      ),
    })),

  setQueuedTurns: (sessionId, turns) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, queuedTurns: seedQueuedTurns(turns) } : s
      ),
    })),

  trackQueuedTurnEvent: (event) => {
    if (event.type !== 'turn.queued' && event.type !== 'turn.dequeued' && event.type !== 'turn.queue-held' && event.type !== 'status') return
    set((state) => {
      let changed = false
      const sessions = state.sessions.map((s) => {
        if (s.id !== event.threadId) return s
        const revision = event.type === 'status' ? s.queuedTurnRevision : (s.queuedTurnRevision ?? 0) + 1
        const current = s.queuedTurns ?? NO_QUEUED_TURNS
        const next = applyQueuedTurnEvent(current, event)
        // A cancelled or dropped message never reached the agent, so its row
        // goes too, on every client (the backend replaced the stored copy).
        const cancelled = event.type === 'turn.dequeued' && queuedRowRemoved(event.reason)
          && s.messages.some((m) => m.id === event.messageId)
        if (next === current && !cancelled && revision === s.queuedTurnRevision) return s
        changed = true
        return {
          ...s,
          queuedTurns: next,
          queuedTurnRevision: revision,
          ...(cancelled ? { messages: s.messages.filter((m) => m.id !== event.messageId) } : {}),
        }
      })
      return changed ? { sessions } : state
    })
  },

  setPendingRequests: (sessionId, pending) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, pendingRequests: pending } : s
      ),
    })),

  trackPendingRequestEvent: (event) => {
    if (!PENDING_REQUEST_EVENT_TYPES.has(event.type)) return
    set((state) => {
      let changed = false
      const sessions = state.sessions.map((s) => {
        if (s.id !== event.threadId) return s
        changed = true
        const pendingRequestRevision = (s.pendingRequestRevision ?? 0) + 1
        const current = s.pendingRequests ?? []
        const next = applyPendingRequestEvent(current, event)
        return next === current
          ? { ...s, pendingRequestRevision }
          : { ...s, pendingRequestRevision, pendingRequests: next }
      })
      return changed ? { sessions } : state
    })
  },

  getActiveSession: () => {
    const { sessions, activeSessionId } = get()
    return sessions.find((s) => s.id === activeSessionId)
  },

  setTitle: (sessionId, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, title } : s
      ),
    })),

  setRuntimeMode: (sessionId, mode) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, runtimeMode: mode, runtimeModeUnresolved: undefined } : s
      ),
    })),

  setModel: (sessionId, model) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, model } : s
      ),
    })),

  setResolvedModel: (sessionId, resolvedModel) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, resolvedModel } : s
      ),
    })),

  setReasoningEffort: (sessionId, effort) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, reasoningEffort: effort } : s
      ),
    })),

  setCostUsd: (sessionId, costUsd) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, costUsd } : s
      ),
    })),

  setVariants: (sessionId, available, current) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, availableVariants: available, currentVariant: current }
          : s
      ),
    })),

  setTokenUsage: (sessionId, usage) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              tokenUsage: {
                usedTokens: usage.usedTokens,
                // Merge: an event that doesn't know the max must not clobber
                // a known window size back to the 200k fallback.
                maxTokens: usage.maxTokens ?? s.tokenUsage?.maxTokens ?? null,
              },
            }
          : s
      ),
    })),

  setAgentType: (sessionId, type) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        // Also clear the model - a model id from one provider is almost
        // never valid on another (e.g. nvidia-nim/* on Codex). Clearing
        // forces the next session to use the new provider's default
        // instead of carrying over an orphan id that the ModelPicker
        // would render as "custom". Same logic for `instanceId` -
        // instances are scoped to a single agent kind; carrying one
        // over after a switch would point at a stale row from the
        // previous kind. `resumeSessionId` is also cleared because
        // session-id namespaces differ across kinds (Claude UUID vs.
        // Codex rollout id) - there's no migration path.
        s.id === sessionId
          ? { ...s, type, model: undefined, resolvedModel: undefined, instanceId: undefined, resumeSessionId: undefined }
          : s
      ),
    })),

  setDraftOptions: (sessionId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId && s.draft ? { ...s, draft: { ...s.draft, ...patch } } : s,
      ),
    })),

  setInstanceId: (sessionId, instanceId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        // Keep `resumeSessionId` - the Claude adapter migrates the session
        // JSONL across profiles when `oauth_dir` differs, so resume by UUID
        // still works. Clearing here would silently drop conversation
        // history on every instance switch.
        s.id === sessionId ? { ...s, instanceId } : s,
      ),
    })),

  setWorktree: (sessionId, worktreePath, worktreeBranch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        // Following a worktree also resolves any pending drift suggestion.
        s.id === sessionId ? { ...s, worktreePath, worktreeBranch, driftSuggestion: null } : s,
      ),
    })),

  applyExecutionRoot: (sessionId, root) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s
        if ((s.executionRootRevision ?? 0) >= root.revision) return s
        // `isWorktree` comes from the backend rather than being recomputed
        // here. The renderer cannot realpath, and on macOS a project under
        // /var compares unequal to its own /private/var realpath - so a move
        // back to the checkout would render a worktree chip for the checkout.
        return {
          ...s,
          worktreePath: root.isWorktree ? root.path : null,
          worktreeBranch: root.isWorktree ? root.branch : null,
          executionRootRevision: root.revision,
          driftSuggestion: null,
        }
      }),
    })),

  syncExecutionRootRevision: (sessionId, revision) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId && (s.executionRootRevision ?? 0) < revision
          ? { ...s, executionRootRevision: revision }
          : s,
      ),
    })),

  setDriftSuggestion: (sessionId, suggestion) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, driftSuggestion: suggestion } : s,
      ),
    })),

  setFollowNoticeDismissed: (sessionId, dismissed) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, followNoticeDismissed: dismissed } : s,
      ),
    })),

  requestScrollToMessage: (sessionId, messageId, query) =>
    set({ pendingScrollToMessage: { sessionId, messageId, stamp: Date.now(), ...(query ? { query } : {}) } }),

  requestScrollToTimestamp: (sessionId, messageTimestamp) =>
    set({ pendingScrollToMessage: { sessionId, messageTimestamp, stamp: Date.now() } }),

  clearScrollToMessage: () => set({ pendingScrollToMessage: null }),

  requestChatFind: (sessionId, query, messageId) =>
    set({ pendingChatFind: { sessionId, query, messageId, stamp: Date.now() } }),

  clearChatFind: () => set({ pendingChatFind: null }),
}))
