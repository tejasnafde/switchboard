import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useAgentStore, type RuntimeMode } from '../../stores/agent-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { ContextWindowMeter } from './ContextWindowMeter'
import { SLASH_COMMANDS } from './slashCommands'
import { generateTitle } from '@shared/auto-title'
import { onSessionRename, emitSessionRename } from '../../services/session-events'
import { notifyTurnCompleted } from '../../services/notifications'
import { InPaneSearchBar } from '../InPaneSearchBar'
import type { AgentType, AgentStatus, ChatMessage } from '@shared/types'

interface ChatPanelProps {
  /**
   * Override the session this panel renders. Defaults to the global
   * `activeSessionId` so existing single-panel usage keeps working. Pass
   * an explicit ID when mounting a second panel in dual-chat mode.
   */
  sessionIdOverride?: string | null
  /** Optional close button for the right-hand panel in dual mode. */
  onClose?: () => void
}

export function ChatPanel({ sessionIdOverride, onClose }: ChatPanelProps = {}) {
  const [agentType, setAgentType] = useState<AgentType>('claude-code')
  const [contextUsage, setContextUsage] = useState<{ usedTokens: number; maxTokens: number | null }>({ usedTokens: 0, maxTokens: null })
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const activeSession = useAgentStore((s) => {
    const resolvedId = sessionIdOverride ?? s.activeSessionId
    return s.sessions.find((sess) => sess.id === resolvedId)
  })
  const {
    appendMessage,
    updateMessage,
    updateStatus,
    setTitle,
    setRuntimeMode: storeSetRuntimeMode,
    setModel: storeSetModel,
    setReasoningEffort: storeSetReasoningEffort,
    setAgentType: storeSetAgentType,
    clearMessages,
    removeSession,
  } = useAgentStore()
  const providerStartedRef = useRef<Set<string>>(new Set())
  const pendingNoteRef = useRef<{ sessionId: string; text: string } | null>(null)
  const agentStartedRef = useRef<Set<string>>(new Set())
  const [slashHelpOpen, setSlashHelpOpen] = useState(false)

  // ── In-pane ⌘F search ────────────────────────────────────────────
  // Filters this panel's messages by substring and steps through them.
  // Reuses `requestScrollToMessage` (the same plumbing ⌘⇧F uses) so
  // the virtualizer can land on the right row + flash-highlight it.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const requestScrollToMessage = useAgentStore((s) => s.requestScrollToMessage)

  const messages = activeSession?.messages ?? []
  const status = activeSession?.status ?? 'idle'
  const hasSession = activeSession !== undefined
  const sessionId = activeSession?.id ?? null
  const projectPath = activeSession?.projectPath
  const resumeSessionId = activeSession?.resumeSessionId
  const chatTitle = activeSession?.title ?? 'New conversation'
  const folderName = projectPath?.split('/').pop() ?? ''
  const runtimeMode = activeSession?.runtimeMode ?? 'sandbox'
  const model = activeSession?.model
  const reasoningEffort = activeSession?.reasoningEffort

  const handleRuntimeModeChange = useCallback((mode: RuntimeMode) => {
    if (!sessionId) return
    storeSetRuntimeMode(sessionId, mode)
    // Propagate to active provider session if running
    ;window.api.provider?.setRuntimeMode?.(sessionId, mode).catch(() => {})
  }, [sessionId, storeSetRuntimeMode])

  const handleModelChange = useCallback((m: string) => {
    if (!sessionId) return
    storeSetModel(sessionId, m)
    // Propagate to the running provider session (opencode reads this per
    // turn; Claude/Codex no-op). Without this, the adapter keeps using
    // whatever model was passed at startSession forever.
    window.api.provider.setModel?.(sessionId, m).catch(() => {})
  }, [sessionId, storeSetModel])

  const handleReasoningEffortChange = useCallback((effort: 'low' | 'medium' | 'high') => {
    if (!sessionId) return
    storeSetReasoningEffort(sessionId, effort)
  }, [sessionId, storeSetReasoningEffort])

  useEffect(() => {
    if (activeSession?.type) {
      setAgentType(activeSession.type)
    }
  }, [activeSession?.type])

  /**
   * Wrap setAgentType so switching mid-chat tears down the old provider
   * session and clears the started refs. The next handleSend will call
   * provider.startSession with the newly-picked kind, giving the appearance
   * of continuing the same chat with a different agent. Without this, the
   * dropdown would stay disabled (canChangeAgent false) forever after the
   * first turn because the ref never clears.
   */
  const handleAgentTypeChange = useCallback((t: AgentType) => {
    setAgentType(t)
    if (sessionId) {
      // Write-through to the store so other consumers (StatusBar, sidebar
      // session badges, command-palette filters) see the new agent type
      // immediately. setAgentType also clears the stored `model` — a model
      // id from one provider almost never round-trips to another (e.g.
      // OpenCode's `nvidia-nim/z-ai/glm-5.1` is meaningless on Codex), and
      // leaving the orphan id in place caused ModelPicker to fall into
      // its "custom" branch on the new agent.
      storeSetAgentType(sessionId, t)
      // Best-effort: stop the old session. If it was never started this is
      // a no-op in main (handler checks sessionAdapters).
      window.api.provider?.stopSession?.(sessionId).catch(() => {})
      providerStartedRef.current.delete(sessionId)
      agentStartedRef.current.delete(sessionId)
    }
  }, [sessionId, storeSetAgentType])

  // ── Provider event listener (new SDK bridge) ──────────────────
  useEffect(() => {
    if (!window.api.provider?.onEvent) {
      return
    }

    const removeProvider = window.api.provider.onEvent((event) => {
      const tid = event.threadId
      if (!tid) return

      switch (event.type) {
        case 'content': {
          const sessions = useAgentStore.getState().sessions
          const session = sessions.find((s) => s.id === tid)
          const existing = session?.messages.find((m) => m.id === event.messageId)
          if (existing) {
            updateMessage(tid, event.messageId, { content: event.text })
          } else {
            appendMessage(tid, {
              id: event.messageId,
              role: 'assistant',
              content: event.text,
              timestamp: Date.now(),
            })
          }
          break
        }
        case 'tool.started': {
          appendMessage(tid, {
            id: `tool_${event.toolId}`,
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: event.toolId,
              name: event.toolName,
              input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2),
            }],
            timestamp: Date.now(),
          })
          break
        }
        case 'tool.completed': {
          const sessions = useAgentStore.getState().sessions
          const session = sessions.find((s) => s.id === tid)
          const toolMsg = session?.messages.find((m) =>
            m.toolCalls?.some((tc) => tc.id === event.toolId)
          )
          if (toolMsg) {
            updateMessage(tid, toolMsg.id, {
              toolCalls: toolMsg.toolCalls?.map((tc) =>
                tc.id === event.toolId ? { ...tc, output: event.output } : tc
              ),
            })
          }
          break
        }
        case 'tool.denied': {
          // Policy-level denial (e.g. Plan mode blocked a Write). Render as
          // a denial pill in the chat stream so the user sees the block.
          appendMessage(tid, {
            id: `denied_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            role: 'system',
            content: '',
            timestamp: Date.now(),
            denial: {
              toolName: event.toolName,
              reason: event.reason,
              mode: event.mode,
            },
          })
          break
        }
        case 'request.opened': {
          appendMessage(tid, {
            id: `approval_${event.requestId}`,
            role: 'assistant',
            content: '',
            approval: {
              toolName: event.toolName,
              detail: event.detail,
              status: 'pending',
            },
            timestamp: Date.now(),
          })
          break
        }
        case 'request.closed': {
          const sessions = useAgentStore.getState().sessions
          const session = sessions.find((s) => s.id === tid)
          const approvalMsg = session?.messages.find((m) => m.id === `approval_${event.requestId}`)
          if (approvalMsg?.approval) {
            updateMessage(tid, approvalMsg.id, {
              approval: {
                ...approvalMsg.approval,
                status: event.decision === 'approve' ? 'accepted' : 'rejected',
              },
            })
          }
          break
        }
        case 'turn.completed': {
          if (event.usedTokens) {
            setContextUsage({
              usedTokens: event.usedTokens,
              maxTokens: event.maxTokens ?? null,
            })
          }
          // Stamp wall-clock duration on the last assistant message so the
          // bubble can render "Worked for X.Xs" Cursor-style.
          if (event.durationMs !== undefined) {
            const store = useAgentStore.getState()
            const sessForDur = store.sessions.find((s) => s.id === tid)
            if (sessForDur) {
              for (let i = sessForDur.messages.length - 1; i >= 0; i--) {
                if (sessForDur.messages[i].role === 'assistant') {
                  store.updateMessage(tid, sessForDur.messages[i].id, {
                    turnDurationMs: event.durationMs,
                  })
                  break
                }
              }
            }
          }
          // Native OS notification if user isn't looking at this chat.
          const store = useAgentStore.getState()
          const sess = store.sessions.find((s) => s.id === tid)
          if (sess) {
            const projectName = sess.projectPath?.split('/').pop()
            const agentLabel = sess.type === 'codex' ? 'Codex' : sess.type === 'opencode' ? 'OpenCode' : 'Claude Code'
            void notifyTurnCompleted({
              sessionTitle: sess.title ?? 'New conversation',
              projectName,
              agentLabel,
              threadId: tid,
              activeSessionId: store.activeSessionId,
              onClick: () => store.setActiveSession(tid),
            })
          }
          break
        }
        case 'context_window': {
          // Real context usage from SDK — reflects compaction too
          setContextUsage({
            usedTokens: event.usedTokens,
            maxTokens: event.maxTokens ?? null,
          })
          // ACP adapters (currently OpenCode) also forward cumulative cost
          // here. Push it onto the session so StatusBar can display it.
          if (typeof event.costUsd === 'number') {
            useAgentStore.getState().setCostUsd(tid, event.costUsd)
          }
          break
        }
        case 'model.variants': {
          // Agent-reported variant set for the currently selected model
          // (OpenCode ACP). Drives the chip group next to the model picker.
          useAgentStore.getState().setVariants(tid, event.availableVariants, event.currentVariant)
          break
        }
        case 'plan.proposed': {
          appendMessage(tid, {
            id: `plan_${event.planId}`,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            plan: { id: event.planId, markdown: event.planMarkdown },
          })
          break
        }
        case 'question.asked': {
          appendMessage(tid, {
            id: `question_${event.requestId}`,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            question: {
              requestId: event.requestId,
              questions: event.questions,
              status: 'pending',
            },
          })
          // If this session is linked to a kanban card, surface the wait
          // on the board: in_progress → needs_input. Only auto-promote
          // from in_progress so we don't disturb backlog/done cards.
          const askedCard = useKanbanStore.getState().findByConversationId(tid)
          if (askedCard?.status === 'in_progress') {
            void useKanbanStore.getState().update(askedCard.id, { status: 'needs_input' })
          }
          break
        }
        case 'question.answered': {
          const sessions = useAgentStore.getState().sessions
          const session = sessions.find((s) => s.id === tid)
          const qMsg = session?.messages.find((m) => m.id === `question_${event.requestId}`)
          if (qMsg?.question) {
            updateMessage(tid, qMsg.id, {
              question: { ...qMsg.question, status: 'answered', answers: event.answers },
            })
          }
          // Reverse the auto-promotion from question.asked.
          const answeredCard = useKanbanStore.getState().findByConversationId(tid)
          if (answeredCard?.status === 'needs_input') {
            void useKanbanStore.getState().update(answeredCard.id, { status: 'in_progress' })
          }
          break
        }
        case 'error': {
          appendMessage(tid, {
            id: `error_${Date.now()}`,
            role: 'system',
            content: `Error: ${event.message}`,
            timestamp: Date.now(),
          })
          break
        }
        case 'status': {
          updateStatus(tid, event.status as AgentStatus)
          break
        }
      }
    })
    return () => removeProvider()
  }, [appendMessage, updateMessage, updateStatus])

  // ── Legacy agent event listeners (old --print mode) ───────────
  useEffect(() => {
    const removeMessage = window.api.agent.onMessage((agentId, message) => {
      appendMessage(agentId, message as ChatMessage)
      const msg = message as ChatMessage
      window.api.app.saveMessage({
        id: msg.id,
        conversationId: agentId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : undefined,
      }).catch(() => {})
    })
    const removeUpdate = window.api.agent.onMessageUpdate?.((agentId, messageId, updates) => {
      updateMessage(agentId, messageId, updates as Partial<ChatMessage>)
    }) ?? (() => {})
    const removeStatus = window.api.agent.onStatus((agentId, s) => {
      updateStatus(agentId, s as AgentStatus)
    })
    const removeError = window.api.agent.onError((agentId, error) => {
      appendMessage(agentId, {
        id: `error_${Date.now()}`,
        role: 'system',
        content: `Error: ${error}`,
        timestamp: Date.now(),
      })
    })
    return () => { removeMessage(); removeUpdate(); removeStatus(); removeError() }
  }, [appendMessage, updateMessage, updateStatus])

  // ── Approval handler ──────────────────────────────────────────
  const handleApproval = useCallback((requestId: string, decision: 'approve' | 'deny', note?: string) => {
    if (!sessionId) return
    ;window.api.provider?.respondToRequest(sessionId, requestId, decision)
    if (note) {
      pendingNoteRef.current = { sessionId, text: note }
    }
  }, [sessionId])

  const handleAnswerQuestion = useCallback((requestId: string, answers: string[][]) => {
    if (!sessionId) return
    ;window.api.provider?.answerQuestion?.(sessionId, requestId, answers).catch(() => {})
  }, [sessionId])

  const handlePlanAction = useCallback((_planId: string, action: 'implement' | 'iterate') => {
    if (!sessionId) return
    // Switch session out of plan mode and send an appropriate follow-up
    if (action === 'implement') {
      storeSetRuntimeMode(sessionId, 'sandbox')
      ;window.api.provider?.setRuntimeMode?.(sessionId, 'sandbox').catch(() => {})
      setTimeout(() => handleSend('Implement the plan you proposed.'), 50)
    } else {
      setTimeout(() => {
        // Focus the chat input so user can iterate on the plan
        const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
        ta?.focus()
      }, 50)
    }
  // handleSend is defined below; safe as long as sessionId/deps are right
  }, [sessionId, storeSetRuntimeMode])

  // Flush a pending approval note once the agent is idle again
  useEffect(() => {
    const pending = pendingNoteRef.current
    if (!pending) return
    if (status !== 'idle') return
    if (pending.sessionId !== sessionId) return
    pendingNoteRef.current = null
    // Send via the existing handleSend path so UI + provider see it
    setTimeout(() => {
      handleSend(pending.text)
    }, 100)
    // handleSend isn't in deps since we don't want to re-fire — it's called once
  }, [status, sessionId])

  // ── Rename handler ────────────────────────────────────────────
  const startRename = useCallback(() => {
    setEditTitleValue(chatTitle)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }, [chatTitle])

  const commitRename = useCallback(() => {
    const trimmed = editTitleValue.trim()
    if (trimmed && sessionId) {
      setTitle(sessionId, trimmed)
      window.api.app.renameConversation(sessionId, trimmed).catch(() => {})
      emitSessionRename(sessionId, trimmed)
    }
    setEditingTitle(false)
  }, [editTitleValue, sessionId, setTitle])

  // Listen for renames from other places (Sidebar) and update agent-store
  useEffect(() => {
    return onSessionRename((sid, title) => {
      setTitle(sid, title)
    })
  }, [setTitle])

  // ── Send handler ──────────────────────────────────────────────
  const handleSend = useCallback(
    async (
      message: string,
      _mode?: string,
      images?: Array<{ file: File; previewUrl: string }>,
      extras?: {
        displayBody?: string
        pillsMeta?: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }>
      },
    ) => {
      if (!sessionId) return

      // Convert attached images to data URLs so they survive session reloads
      let messageImages: import('@shared/types').MessageImage[] | undefined
      if (images && images.length > 0) {
        const urls = await Promise.all(images.map(async (img) => {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(img.file)
          })
          return {
            url: dataUrl,
            mimeType: img.file.type,
            name: img.file.name,
          }
        }))
        messageImages = urls
      }

      const userMsg: ChatMessage = {
        id: `user_${Date.now()}`,
        role: 'user',
        content: message,
        images: messageImages,
        timestamp: Date.now(),
        displayBody: extras?.displayBody,
        pillsMeta: extras?.pillsMeta,
      }
      appendMessage(sessionId, userMsg)
      // Optimistic status so the "thinking" indicator shows immediately —
      // real status events from the provider will override this.
      updateStatus(sessionId, 'running')

      window.api.app.saveMessage({
        id: userMsg.id,
        conversationId: sessionId,
        role: 'user',
        content: message,
        images: messageImages ? JSON.stringify(messageImages) : undefined,
        displayBody: extras?.displayBody,
        pillsMeta: extras?.pillsMeta ? JSON.stringify(extras.pillsMeta) : undefined,
      }).catch(() => {})

      // Auto-generate title from first user message
      if (messages.length === 0) {
        const title = generateTitle(message)
        setTitle(sessionId, title)
        window.api.app.renameConversation(sessionId, title).catch(() => {})
        emitSessionRename(sessionId, title)
      }

      // Provider path (SDK). Legacy `--print` agent path removed — all
      // traffic now goes through the Claude Agent SDK / Codex app-server
      // via the provider bridge.
      const providerApi = window.api.provider
      const providerKind = agentType === 'codex' ? 'codex' : agentType === 'opencode' ? 'opencode' : 'claude'
      const effectiveMode = runtimeMode

      if (!providerStartedRef.current.has(sessionId)) {
        providerStartedRef.current.add(sessionId)
        try {
          // Kanban-launched sessions run inside a per-card git worktree.
          // The session's `projectPath` is the parent project (so the
          // sidebar groups correctly), but the agent process must run in
          // the worktree dir to see isolated changes. The card itself
          // owns the worktree path, so we look it up by conversationId.
          const linkedCard = useKanbanStore.getState().findByConversationId(sessionId)
          const cwd = linkedCard?.worktreePath ?? projectPath ?? '.'
          await providerApi.startSession({
            threadId: sessionId,
            provider: providerKind,
            cwd,
            runtimeMode: effectiveMode,
            resumeSessionId,
            model: model || undefined,
            reasoningEffort,
          })
        } catch (err) {
          appendMessage(sessionId, {
            id: `error_${Date.now()}`,
            role: 'system',
            content: `Failed to start session: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now(),
          })
          providerStartedRef.current.delete(sessionId)
          return
        }
      }

      providerApi.sendTurn(sessionId, message, runtimeMode, messageImages).catch((err: Error) => {
        appendMessage(sessionId, {
          id: `error_${Date.now()}`,
          role: 'system',
          content: `Failed to send: ${err.message}`,
          timestamp: Date.now(),
        })
      })
    },
    [sessionId, agentType, projectPath, runtimeMode, appendMessage, messages.length, resumeSessionId, setTitle],
  )

  // ── In-pane search: compute matching message ids (substring on text) ──
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return [] as string[]
    return messages
      .filter((m) => {
        // Search the user-visible text content. Tool calls / images aren't
        // included; the global ⌘⇧F covers FTS over the full DB.
        if (typeof m.content === 'string' && m.content.toLowerCase().includes(q)) return true
        return false
      })
      .map((m) => m.id)
  }, [searchQuery, messages])

  // Whenever the query or message list changes, clamp the cursor and
  // ask MessageList to jump to the current match.
  useEffect(() => {
    if (!searchOpen) return
    if (searchMatches.length === 0) return
    const safe = ((searchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length
    if (safe !== searchIdx) {
      setSearchIdx(safe)
      return
    }
    if (sessionId) requestScrollToMessage(sessionId, searchMatches[safe], searchQuery)
  }, [searchOpen, searchMatches, searchIdx, sessionId, searchQuery, requestScrollToMessage])

  const handleChatSearchQuery = useCallback((q: string) => {
    setSearchQuery(q)
    setSearchIdx(0)
  }, [])
  const handleChatSearchNext = useCallback(() => {
    setSearchIdx((i) => i + 1)
  }, [])
  const handleChatSearchPrev = useCallback(() => {
    setSearchIdx((i) => i - 1)
  }, [])
  const handleChatSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIdx(0)
    // Strip any <mark class="sb-search-mark"> we injected so the chat
    // returns to its normal rendering.
    document.querySelectorAll('mark.sb-search-mark').forEach((m) => {
      const parent = m.parentNode
      if (!parent) return
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    })
  }, [])

  // ⌘F intercept — uses a document-level capture listener instead of an
  // onKeyDownCapture on the wrapper, because the wrapper is only on the
  // capture path when document.activeElement is INSIDE this panel. After
  // the user clicks the chat title, sidebar, or anywhere ambiguous the
  // active element falls back to <body> and a wrapper-attached handler
  // never fires. Document-level lets us scope via a ref check + a
  // "default panel" fallback (matches activeSessionId).
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Accept ⌘F on macOS or Ctrl+F on Windows/Linux. Reject combos
      // that include both (Ctrl+Cmd+F is the macOS fullscreen toggle).
      const cmd = e.metaKey && !e.ctrlKey
      const ctrl = e.ctrlKey && !e.metaKey
      if (!((cmd || ctrl) && !e.altKey && !e.shiftKey)) return
      if (e.key !== 'f' && e.key !== 'F') return
      const el = panelRef.current
      if (!el) return
      const active = document.activeElement as Element | null
      const inThisPanel = !!active && el.contains(active)
      // If focus is inside ANOTHER chat panel (dual-chat mode), don't
      // steal — that panel's listener will handle it.
      const inAnyChatPanel = !!active && !!active.closest('[data-chat-panel="true"]')
      // If focus is inside a terminal (xterm), the terminal pane will
      // claim ⌘F via its own listener — bail so we don't double-trigger.
      const inTerminal = !!active && (
        active.classList.contains('xterm-helper-textarea') ||
        !!active.closest('.xterm') ||
        !!active.closest('[data-terminal-pane="true"]')
      )
      if (inTerminal) return
      if (!inThisPanel) {
        if (inAnyChatPanel) return
        // Focus is somewhere neutral (body, sidebar, etc). Only the
        // "default" (active-session) panel should claim ⌘F so dual-chat
        // doesn't double-trigger.
        const isDefault = sessionIdOverride == null
        if (!isDefault) return
      }
      e.preventDefault()
      e.stopPropagation()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [sessionIdOverride])

  const chatSearchMatchInfo = searchOpen
    ? {
        current: searchMatches.length === 0 ? 0 : (searchIdx % searchMatches.length + searchMatches.length) % searchMatches.length + 1,
        total: searchMatches.length,
      }
    : null

  return (
    <div
      ref={panelRef}
      data-chat-panel="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'var(--bg-primary)',
        position: 'relative',
      }}
    >
      {searchOpen && (
        <InPaneSearchBar
          onQuery={handleChatSearchQuery}
          onNext={handleChatSearchNext}
          onPrev={handleChatSearchPrev}
          onClose={handleChatSearchClose}
          matches={chatSearchMatchInfo}
          placeholder="Find in chat"
        />
      )}
      {/* ── Top bar: folder / chat name ──────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '7px 16px',
          borderBottom: '1px solid var(--border)',
          gap: '6px',
          flexShrink: 0,
          background: 'var(--bg-secondary)',
          fontSize: '12px',
          minHeight: '32px',
        }}
      >
        {/* Status dot */}
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flexShrink: 0,
            background:
              status === 'running' || status === 'thinking'
                ? 'var(--success)'
                : status === 'error'
                  ? 'var(--error)'
                  : 'var(--text-muted)',
            boxShadow:
              status === 'running' || status === 'thinking'
                ? '0 0 6px var(--success)'
                : 'none',
          }}
        />

        {/* Folder / Chat name — flex group that truncates cleanly */}
        {hasSession ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flex: '1 1 0%',
            minWidth: 0,
            overflow: 'hidden',
          }}>
            {folderName && (
              <>
                <span
                  title={projectPath}
                  style={{
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flexShrink: 1,
                    minWidth: 0,
                    maxWidth: '40%',
                  }}
                >
                  {folderName}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '10px', flexShrink: 0 }}>/</span>
              </>
            )}
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingTitle(false)
                }}
                onBlur={commitRename}
                style={{
                  border: '1px solid var(--border-focus)',
                  borderRadius: '3px',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                  padding: '1px 6px',
                  outline: 'none',
                  flex: '1 1 0%',
                  minWidth: 0,
                }}
              />
            ) : (
              <span
                title={chatTitle}
                style={{
                  color: 'var(--text-primary)',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flexShrink: 1,
                  minWidth: 0,
                }}
              >
                {chatTitle}
              </span>
            )}
            {!editingTitle && (
              <button
                onClick={startRename}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '0 2px',
                  display: 'flex',
                  alignItems: 'center',
                  opacity: 0.5,
                  transition: 'opacity 0.12s',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
                title="Rename"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
            )}
          </div>
        ) : (
          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>Switchboard</span>
        )}

        <span style={{ flex: 1 }} />

        {/* Right-panel close button (only shown when this is the secondary
            panel in dual-chat mode — passed via `onClose` prop) */}
        {onClose && (
          <button
            onClick={onClose}
            title="Close this panel (⌘⇧\\)"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: '3px',
              fontSize: '14px',
              lineHeight: 1,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)' }}
          >
            ×
          </button>
        )}

        {/* Status text */}
        {hasSession && (
          <span style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 400 }}>
            {status === 'running' ? 'thinking\u2026' : status === 'idle' ? 'ready' : status}
          </span>
        )}
      </div>

      {/* Messages */}
      <MessageList
        messages={messages}
        sessionId={sessionId}
        agentType={activeSession?.type ?? agentType}
        onApproval={handleApproval}
        onAnswerQuestion={handleAnswerQuestion}
        onPlanAction={handlePlanAction}
      />

      {/* Thinking indicator */}
      {(status === 'running' || status === 'thinking') && (
        <div style={{
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
          color: 'var(--text-muted)',
          flexShrink: 0,
        }}>
          <span className="thinking-dots" style={{ display: 'inline-flex', gap: '3px' }}>
            <span style={{ animation: 'pulse 1.4s ease-in-out infinite', animationDelay: '0s', width: '4px', height: '4px', borderRadius: '50%', background: 'var(--accent)' }} />
            <span style={{ animation: 'pulse 1.4s ease-in-out infinite', animationDelay: '0.2s', width: '4px', height: '4px', borderRadius: '50%', background: 'var(--accent)' }} />
            <span style={{ animation: 'pulse 1.4s ease-in-out infinite', animationDelay: '0.4s', width: '4px', height: '4px', borderRadius: '50%', background: 'var(--accent)' }} />
          </span>
          <span>{status === 'thinking' ? 'Thinking\u2026' : 'Working\u2026'}</span>
        </div>
      )}

      {/* Input — now includes runtime mode + context meter in footer */}
      <ChatInput
        sessionId={sessionId}
        onSend={handleSend}
        disabled={!hasSession || status === 'exited'}
        placeholder={
          status === 'exited'
            ? 'Agent has exited. Start a new session.'
            : !hasSession
              ? 'Click "+ New Chat" or select a session to start...'
              : status === 'running' || status === 'thinking'
                ? 'Queue a follow-up\u2026 will send after current turn.'
                : 'Message the agent...'
        }
        agentType={agentType}
        onAgentTypeChange={handleAgentTypeChange}
        canChangeAgent={
          // Allow switching agent unless a turn is actively running. We
          // tear down the old provider session on switch so the next send
          // cleanly spins up a fresh one under the new provider.
          !hasSession || (status !== 'running' && status !== 'thinking')
        }
        runtimeMode={runtimeMode}
        onRuntimeModeChange={handleRuntimeModeChange}
        model={model}
        onModelChange={handleModelChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={handleReasoningEffortChange}
        contextUsage={hasSession ? {
          // Rough approximation: ~4 chars per token. Real data arrives via turn.completed events.
          usedTokens: contextUsage.usedTokens || Math.round(messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4),
          maxTokens: contextUsage.maxTokens ?? 200000,
        } : undefined}
        isRunning={status === 'running' || status === 'thinking'}
        onInterrupt={() => {
          if (sessionId) {
            window.api.provider?.interrupt?.(sessionId).catch(() => {})
          }
        }}
        onClearMessages={() => {
          if (sessionId) clearMessages(sessionId)
        }}
        onArchive={() => {
          if (!sessionId) return
          window.api.app.archiveConversation(sessionId, projectPath, chatTitle).catch(() => {})
          removeSession(sessionId)
        }}
        onShowSlashHelp={() => setSlashHelpOpen(true)}
      />

      {slashHelpOpen && (
        <SlashHelpOverlay onClose={() => setSlashHelpOpen(false)} />
      )}
    </div>
  )
}

function SlashHelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '520px',
          maxWidth: '100%',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>Slash Commands</span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '6px 0' }}>
          {SLASH_COMMANDS.map((cmd) => (
            <div key={cmd.name} style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '12px',
              padding: '7px 14px',
              fontSize: '12.5px',
            }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: 'var(--accent)',
                minWidth: '80px',
              }}>
                /{cmd.name}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {cmd.description}
              </span>
            </div>
          ))}
        </div>
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          Type <kbd style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            padding: '0 4px',
            background: 'var(--bg-tertiary)',
            borderRadius: '3px',
          }}>/</kbd> at the start of a line to open the inline menu.
        </div>
      </div>
    </div>
  )
}
