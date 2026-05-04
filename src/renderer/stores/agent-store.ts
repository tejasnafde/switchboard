import { create } from 'zustand'
import type { AgentStatus, AgentType, ChatMessage } from '@shared/types'
import type { ReasoningEffort } from '@shared/models'

export type RuntimeMode = 'plan' | 'sandbox' | 'accept-edits' | 'full-access'

/**
 * Module-level "last chosen" runtime mode used as the default seed when a
 * new session is created and the caller doesn't pass an explicit mode. This
 * is the user-visible "source of truth" for the default — it gets hydrated
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

interface AgentSession {
  id: string
  type: AgentType
  status: AgentStatus
  messages: ChatMessage[]
  conversationId?: string
  projectPath?: string
  /** Claude CLI session ID for --resume (from imported JSONL sessions) */
  resumeSessionId?: string
  /** Number of unread assistant messages (incremented when not active) */
  unreadCount: number
  /** Display title (user-editable, auto-generated from first message) */
  title?: string
  /** Permission mode for this session (sandbox / accept-edits / full-access / plan) */
  runtimeMode: RuntimeMode
  /** Model identifier (provider-specific — e.g. 'claude-opus-4-5' or 'gpt-5') */
  model?: string
  /**
   * Reasoning effort tier for agents that expose it as a separate selector
   * (currently Codex only). Maps to the `reasoningEffort` param on
   * turn/start. Claude doesn't surface this as a UI control.
   */
  reasoningEffort?: ReasoningEffort
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
}

interface AgentStore {
  sessions: AgentSession[]
  activeSessionId: string | null
  /**
   * Pending "scroll to this message" request — set by SearchModal when the
   * user clicks a result. MessageList picks it up via its subscription and
   * tells the virtualizer to scroll to the right row, then clears.
   * Using a counter stamped into the object ensures the same messageId
   * re-clicked also re-fires the scroll (React can see the state change).
   */
  pendingScrollToMessage: { sessionId: string; messageId: string; stamp: number; query?: string } | null

  addSession: (session: Omit<AgentSession, 'messages' | 'unreadCount' | 'runtimeMode'> & { runtimeMode?: RuntimeMode }) => void
  removeSession: (id: string) => void
  setActiveSession: (id: string) => void
  updateStatus: (id: string, status: AgentStatus) => void
  appendMessage: (sessionId: string, message: ChatMessage) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<ChatMessage>) => void
  setMessages: (sessionId: string, messages: ChatMessage[]) => void
  clearMessages: (sessionId: string) => void
  setConversationId: (sessionId: string, conversationId: string) => void
  getActiveSession: () => AgentSession | undefined
  getUnreadCount: (sessionId: string) => number
  setTitle: (sessionId: string, title: string) => void
  setRuntimeMode: (sessionId: string, mode: RuntimeMode) => void
  setModel: (sessionId: string, model: string) => void
  setReasoningEffort: (sessionId: string, effort: ReasoningEffort) => void
  setCostUsd: (sessionId: string, costUsd: number) => void
  setVariants: (sessionId: string, available: string[], current: string) => void
  setCurrentVariant: (sessionId: string, variant: string) => void
  setTokenUsage: (sessionId: string, usage: { usedTokens: number; maxTokens: number | null }) => void
  /**
   * Switch the agent backend (claude-code / codex / opencode) for a
   * session. Required so consumers like StatusBar — which read from the
   * store rather than the chat-panel-local `agentType` state — see the
   * change immediately. Without this, the bottom status bar lagged the
   * dropdown by a full provider round-trip.
   */
  setAgentType: (sessionId: string, type: AgentType) => void
  requestScrollToMessage: (sessionId: string, messageId: string, query?: string) => void
  clearScrollToMessage: () => void
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  pendingScrollToMessage: null,

  addSession: (session) =>
    set((state) => ({
      sessions: [
        ...state.sessions,
        {
          ...session,
          messages: [],
          unreadCount: 0,
          runtimeMode: session.runtimeMode ?? storeDefaultRuntimeMode,
        },
      ],
      activeSessionId: state.activeSessionId ?? session.id,
    })),

  removeSession: (id) => {
    // Tear down the main-process adapter session before dropping the
    // renderer state. Without this, archiving / closing a tab leaks the
    // adapter process (Codex app-server, OpenCode ACP child, Claude SDK
    // query loop) — they keep their cwd, file handles, and TCP sockets
    // until the whole Electron app exits. Fire-and-forget: if the main
    // process has already cleaned the session up (e.g. on shutdown) the
    // IPC handler is a no-op.
    window.api.provider?.stopSession?.(id).catch((err: unknown) => {
      console.warn(`[agent-store] stopSession(${id}) failed:`, err)
    })
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

  setActiveSession: (id) => set((state) => ({
    activeSessionId: id,
    sessions: state.sessions.map((s) =>
      s.id === id ? { ...s, unreadCount: 0 } : s
    ),
  })),

  updateStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status } : s
      ),
    })),

  appendMessage: (sessionId, message) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s
        // Idempotent: skip if a message with this ID already exists.
        // With multiple ChatPanel panes open each registers its own
        // ipcRenderer listener, so every provider event fires once per
        // pane. Without this guard the same tool.started / content /
        // approval message would be appended twice, causing React to
        // warn about duplicate keys.
        if (s.messages.some((m) => m.id === message.id)) return s
        return {
          ...s,
          messages: [...s.messages, message],
          unreadCount: state.activeSessionId !== sessionId && message.role === 'assistant'
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

  setMessages: (sessionId, messages) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages } : s
      ),
    })),

  clearMessages: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [] } : s
      ),
    })),

  setConversationId: (sessionId, conversationId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, conversationId } : s
      ),
    })),

  getActiveSession: () => {
    const { sessions, activeSessionId } = get()
    return sessions.find((s) => s.id === activeSessionId)
  },

  getUnreadCount: (sessionId) => {
    return get().sessions.find((s) => s.id === sessionId)?.unreadCount ?? 0
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
        s.id === sessionId ? { ...s, runtimeMode: mode } : s
      ),
    })),

  setModel: (sessionId, model) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, model } : s
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

  setCurrentVariant: (sessionId, variant) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, currentVariant: variant } : s
      ),
    })),

  setTokenUsage: (sessionId, usage) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, tokenUsage: usage } : s
      ),
    })),

  setAgentType: (sessionId, type) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        // Also clear the model — a model id from one provider is almost
        // never valid on another (e.g. nvidia-nim/* on Codex). Clearing
        // forces the next session to use the new provider's default
        // instead of carrying over an orphan id that the ModelPicker
        // would render as "custom".
        s.id === sessionId ? { ...s, type, model: undefined } : s
      ),
    })),

  requestScrollToMessage: (sessionId, messageId, query) =>
    set({ pendingScrollToMessage: { sessionId, messageId, stamp: Date.now(), ...(query ? { query } : {}) } }),

  clearScrollToMessage: () => set({ pendingScrollToMessage: null }),
}))
