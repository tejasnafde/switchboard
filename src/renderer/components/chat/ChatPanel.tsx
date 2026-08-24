import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useAgentStore, setStoreDefaultRuntimeMode, type RuntimeMode } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import { useSpendBlockStore } from '../../stores/spend-block-store'
import { useMachineStore } from '../../stores/machine-store'
import { ROTATION_MARKER_PREFIX, AGENT_SWITCH_MARKER_PREFIX, CONTEXT_HANDOFF_MARKER_PREFIX } from './rotationMarker'
import { buildHandoffPreamble, nextPendingHandoffFrom } from '@shared/handoff'
import { parseSendTo, resolveSendToTarget, peerMessageToChatMessage } from './sendToCommand'
import { clearProviderRetry, upsertProviderRetry } from './providerRetry'
import { MessageList } from './MessageList'
import { ChatInput, type ChatSendResult } from './ChatInput'
import { chatIdentity } from './chatIdentity'
import { RemoteAuthBanner, invalidateRemoteAuthCache } from './RemoteAuthBanner'
import { ForkLineageBanner } from './ForkLineageBanner'
import { ContextWindowMeter } from './ContextWindowMeter'
import { SLASH_COMMANDS } from './slashCommands'
import {
  onSessionRename,
  emitSessionRename,
  emitSessionActivity,
  emitUserTurnAccepted,
  onReducedProviderEvent,
} from '../../services/session-events'
import { notifyTurnCompleted } from '../../services/notifications'
import { isAssistantStreamingEnabled } from '../../services/streamingPref'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:panel')
import {
  bufferContent,
  createStreamingBuffer,
  drainTurn,
} from '../../services/streamingBuffer'
import { createContentCoalescer, type ContentCoalescer } from '../../services/contentCoalescer'
import {
  finishRuntimeEventLifecycle,
  messageLifecycle,
  prepareRuntimeEventLifecycle,
} from '../../services/messageLifecycle'
import { applyContentText, type ContentChunk } from '@shared/content-stream'
import {
  echoMessageId,
  validateUserMessageImages,
  visibleUserMessageText,
  type UserTurnSubmissionV1,
} from '@shared/provider-events'
import {
  desktopComposerFingerprint,
  desktopPreparedTurns,
  desktopTurnAttempts,
  submitProgrammaticTurn,
  submitDesktopUserTurn,
  type DesktopTurnSubmissionDependencies,
} from '../../services/desktopTurnSubmission'
import { downscaleImage } from '../../services/imageDownscale'
import { InPaneSearchBar } from '../InPaneSearchBar'
import { defaultInstanceId, agentLabel, type AgentType, type AgentStatus, type ChatMessage } from '@shared/types'
import {
  SETTING_DEFAULT_INSTANCE_ID,
  defaultModelSettingKey,
  SETTING_DEFAULT_RUNTIME_MODE,
} from '@shared/session-defaults'
import { useLayoutStore } from '../../stores/layout-store'
import type { ChatSlot } from '../../services/chatWorkspace'
import { focusComposer } from '../../services/composerRegistry'
import {
  cloneDraftPayload,
  requiresDraftTransferConfirmation,
  withDraftProvenance,
} from '../../services/draftTransfer'

interface ChatPanelProps {
  /**
   * Override the session this panel renders. Legacy unslotted callers fall
   * back to the primary mirror; an explicit slot with no binding stays empty.
   */
  sessionIdOverride?: string | null
  chatSlot?: ChatSlot
  showFocusIndicator?: boolean
  /** Optional close button for the right-hand panel in dual mode. */
  onClose?: () => void
  onOpenBeside?: () => void
}

/**
 * Window-wide, not per panel: exactly one mounted panel claims each event, so
 * with streaming off the whole reply died with the claiming panel when this was
 * per-instance.
 */
const streamingBuffer = createStreamingBuffer()

/**
 * Update a streamed assistant message if it exists, else append a fresh bubble.
 * Shared by the streaming-ON coalescer commit and the streaming-OFF drainTurn
 * flush so the two paths cannot drift.
 */
function upsertAssistantContent(threadId: string, messageId: string, chunk: ContentChunk): void {
  const store = useAgentStore.getState()
  const session = store.sessions.find((s) => s.id === threadId)
  const existing = session?.messages.find((m) => m.id === messageId)
  const text = applyContentText(existing?.content, chunk)
  if (existing) {
    store.updateMessage(threadId, messageId, { content: text })
  } else {
    store.appendMessage(threadId, {
      id: messageId,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    })
  }
}

export function ChatPanel({ sessionIdOverride, chatSlot, showFocusIndicator = false, onClose, onOpenBeside }: ChatPanelProps = {}) {
  const [agentType, setAgentType] = useState<AgentType>('claude-code')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const slotSessionId = useLayoutStore((state) => {
    if (chatSlot === 'primary') return state.primarySessionId
    if (chatSlot === 'secondary') return state.secondarySessionId
    return null
  })
  const focusedChatSlot = useLayoutStore((state) => state.focusedChatSlot)
  const focusChatSlot = useLayoutStore((state) => state.focusChatSlot)
  const activeSession = useAgentStore((s) => {
    const resolvedId = sessionIdOverride ?? (chatSlot ? slotSessionId : s.activeSessionId)
    return s.sessions.find((sess) => sess.id === resolvedId)
  })
  // Per-action selectors (stable identities) instead of a bare useAgentStore(),
  // which subscribed ChatPanel to the whole store and re-rendered it on every
  // token of *other* sessions (e.g. the other dual-chat panel).
  const appendMessage = useAgentStore((s) => s.appendMessage)
  const updateMessage = useAgentStore((s) => s.updateMessage)
  const updateStatus = useAgentStore((s) => s.updateStatus)
  const setTitle = useAgentStore((s) => s.setTitle)
  const storeSetRuntimeMode = useAgentStore((s) => s.setRuntimeMode)
  const storeSetModel = useAgentStore((s) => s.setModel)
  const storeSetReasoningEffort = useAgentStore((s) => s.setReasoningEffort)
  const storeSetAgentType = useAgentStore((s) => s.setAgentType)
  const storeSetInstanceId = useAgentStore((s) => s.setInstanceId)
  const clearMessages = useAgentStore((s) => s.clearMessages)
  const removeSession = useAgentStore((s) => s.removeSession)
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
  // Fallback token estimate only when the adapter hasn't reported real usage.
  // Memoized so it isn't an O(n) sum over all messages on every render (which,
  // because ChatPanel re-renders per token, was O(n^2) across a turn).
  const estimatedTokens = useMemo(
    () => Math.round(messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4),
    [messages],
  )
  const sessionId = activeSession?.id ?? null
  const projectPath = activeSession?.projectPath
  const resumeSessionId = activeSession?.resumeSessionId
  const chatTitle = activeSession?.title ?? 'New conversation'
  const otherSessionId = useLayoutStore((state) => {
    if (chatSlot === 'primary') return state.secondarySessionId
    if (chatSlot === 'secondary') return state.primarySessionId
    return null
  })
  const hasDraftPayload = useDraftStore((state) => Boolean(sessionId && (
    state.drafts[sessionId]
    || state.pillsBySession[sessionId]?.length
    || state.imagesBySession[sessionId]?.length
  )))
  const focusSlot = useCallback(() => {
    if (chatSlot) focusChatSlot(chatSlot)
  }, [chatSlot, focusChatSlot])
  const isVisiblyFocused = showFocusIndicator && chatSlot === focusedChatSlot
  const copyPromptToOtherChat = useCallback(() => {
    if (!sessionId || !otherSessionId || !activeSession) return
    const draftStore = useDraftStore.getState()
    const source = {
      text: draftStore.drafts[sessionId] ?? '',
      pills: draftStore.pillsBySession[sessionId] ?? [],
      images: draftStore.imagesBySession[sessionId] ?? [],
    }
    if (!source.text && source.pills.length === 0 && source.images.length === 0) return
    const targetSession = useAgentStore.getState().sessions.find((candidate) => candidate.id === otherSessionId)
    if (!targetSession) return
    const targetHasDraft = Boolean(
      draftStore.drafts[otherSessionId]
      || draftStore.pillsBySession[otherSessionId]?.length
      || draftStore.imagesBySession[otherSessionId]?.length,
    )
    const crossesBoundary = requiresDraftTransferConfirmation(activeSession, targetSession)
    if ((targetHasDraft || crossesBoundary) && !window.confirm([
      targetHasDraft ? 'Replace the other chat’s existing draft?' : '',
      crossesBoundary ? 'This copies prompt context across a machine or provider profile boundary.' : '',
    ].filter(Boolean).join('\n\n'))) return
    const clone = cloneDraftPayload(source, {
      nextId: () => crypto.randomUUID(),
      createPreviewUrl: (file) => URL.createObjectURL(file),
    })
    draftStore.replaceDraftPayload(otherSessionId, {
      ...clone,
      text: withDraftProvenance(
        clone.text,
        `${chatTitle} · ${agentLabel(activeSession.type)}`,
      ),
    })
    useLayoutStore.getState().selectChatSession(otherSessionId)
    setTimeout(() => focusComposer(otherSessionId), 0)
  }, [activeSession, chatTitle, otherSessionId, sessionId])
  const remoteMachineName = useMachineStore((state) =>
    state.remotes.find((machine) => machine.id === activeSession?.machineId)?.name,
  )
  const identity = useMemo(() => chatIdentity({
    machineId: activeSession?.machineId,
    machineName: remoteMachineName,
    projectPath,
    title: chatTitle,
    worktreeBranch: activeSession?.worktreeBranch,
  }), [activeSession?.machineId, activeSession?.worktreeBranch, chatTitle, projectPath, remoteMachineName])
  const runtimeMode = activeSession?.runtimeMode ?? 'sandbox'
  const model = activeSession?.model
  const resolvedModel = activeSession?.resolvedModel
  const reasoningEffort = activeSession?.reasoningEffort
  const instanceId = activeSession?.instanceId

  const handleRuntimeModeChange = useCallback((mode: RuntimeMode) => {
    if (!sessionId) return
    storeSetRuntimeMode(sessionId, mode)
    // Propagate to active provider session if running
    ;window.api.provider?.setRuntimeMode?.(sessionId, mode).catch(() => {})
    // Persist as the per-conversation source of truth so reopening this
    // chat (sidebar, kanban card click, ⌘⇧F search jump) restores the
    // selection instead of falling back to the hardcoded default.
    window.api.app?.setConversationRuntimeMode?.(sessionId, mode).catch(() => {})
    // Also remember as the user-level default so brand-new sessions seed
    // with this mode instead of always reverting to 'sandbox'.
    setStoreDefaultRuntimeMode(mode)
    window.api.settings
      ?.set?.(SETTING_DEFAULT_RUNTIME_MODE, mode)
      .catch((err: unknown) => log.warn('could not save the default runtime mode', err))
  }, [sessionId, storeSetRuntimeMode])

  const handleModelChange = useCallback((m: string) => {
    if (!sessionId) return
    storeSetModel(sessionId, m)
    // Propagate to the running provider session (opencode reads this per
    // turn; Claude/Codex no-op). Without this, the adapter keeps using
    // whatever model was passed at startSession forever.
    window.api.provider.setModel?.(sessionId, m).catch(() => {})
    // Persist as the per-conversation source of truth so reopening this
    // chat (sidebar, kanban card click) restores the pin instead of losing
    // it the moment the live session object stops matching session.id.
    window.api.app?.setConversationModel?.(sessionId, m).catch(() => {})
    // And as the machine default, so a session started from anywhere else -
    // notably the phone, which cannot see this window - opens on the same
    // model instead of whatever the provider CLI picks.
    window.api.settings
      ?.set?.(defaultModelSettingKey(agentType), m)
      .catch((err: unknown) => log.warn('could not save the default model', err))
    // `agentType` is read above, so it belongs here: without it the callback
    // keeps the agent it was created with and files the model under the wrong
    // one after a provider switch.
  }, [sessionId, storeSetModel, agentType])

  const handleReasoningEffortChange = useCallback((effort: 'low' | 'medium' | 'high') => {
    if (!sessionId) return
    storeSetReasoningEffort(sessionId, effort)
    window.api.app.setConversationReasoningEffort(sessionId, effort).catch(() => {})
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
  const handleAgentTypeChange = useCallback(async (t: AgentType) => {
    if (t === 'terminal') return
    const prevType = agentType
    setAgentType(t)
    if (!sessionId) return
    // Persist first so a failed write cannot leave the picker and DB on
    // different providers.
    try {
      await window.api.app.setConversationProviderSelection(sessionId, t, defaultInstanceId(t))
    } catch (err) {
      setAgentType(prevType)
      log.warn('failed to persist provider selection', err)
      return
    }
    // Persisted in-chat marker: an agent swap silently drops all context
    // (the new adapter starts cold), so make the switch - and its cost -
    // visible and auditable, mirroring the instance-rotation marker below.
    const hasPriorMessages = (activeSession?.messages?.length ?? 0) > 0
    if (hasPriorMessages && prevType !== t) {
      const marker: ChatMessage = {
        id: `agentswap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'system',
        content: `${AGENT_SWITCH_MARKER_PREFIX} ${agentLabel(prevType)} → ${agentLabel(t)}`,
        timestamp: Date.now(),
      }
      appendMessage(sessionId, marker)
      window.api.app.saveMessage({
        id: marker.id,
        conversationId: sessionId,
        role: marker.role,
        content: marker.content,
      }).catch(() => {})
    }
    // Schedule the cross-provider context handoff: the new adapter starts
    // cold, so the next send replays the transcript as a preamble (see
    // handleSend). Folded through the persisted flag so a chain of switches
    // keeps the ORIGINAL source, and switching back to it clears the flag
    // (that provider resumes its own native context).
    try {
      const { from: existing } = await window.api.app.getConversationPendingHandoff(sessionId)
      const next = nextPendingHandoffFrom(existing, prevType, t, hasPriorMessages)
      if (next !== existing) {
        await window.api.app.setConversationPendingHandoff(sessionId, next)
      }
    } catch (err) {
      log.warn('failed to schedule context handoff', err)
    }
    // Write-through to the store so other consumers (StatusBar, sidebar
    // session badges, command-palette filters) see the new agent type
    // immediately. setAgentType also clears the stored `model` - a model
    // id from one provider almost never round-trips to another (e.g.
    // OpenCode's `nvidia-nim/z-ai/glm-5.1` is meaningless on Codex), and
    // leaving the orphan id in place caused ModelPicker to fall into
    // its "custom" branch on the new agent.
    storeSetAgentType(sessionId, t)
    providerStartedRef.current.delete(sessionId)
    agentStartedRef.current.delete(sessionId)
    await window.api.provider?.stopSession?.(sessionId).catch(() => {})
    messageLifecycle.settleThread(sessionId)
  }, [sessionId, storeSetAgentType, agentType, activeSession?.messages?.length, appendMessage])

  // Existing sessions rotate atomically on the backend: it owns stop/start,
  // native-context migration, persistence, and rollback. A conversation that
  // has never started can still save its initial profile locally.
  const handleInstanceChange = useCallback(async (nextInstanceId: string | undefined) => {
    if (!sessionId || !nextInstanceId) return
    const prevInstanceId = instanceId
    if (prevInstanceId === nextInstanceId) return
    let result
    try {
      result = await window.api.provider.switchInstance(sessionId, {
        targetInstanceId: nextInstanceId,
        expectedCurrentInstanceId: prevInstanceId ?? null,
      })
      if (!result.ok && result.code === 'context-conflict') {
        const startFresh = window.confirm(
          `${result.message}\n\nThe current profile is still active. Start the selected profile as a fresh native session and carry the visible conversation into the next turn?`,
        )
        if (!startFresh) return
        result = await window.api.provider.switchInstance(sessionId, {
          targetInstanceId: nextInstanceId,
          expectedCurrentInstanceId: prevInstanceId ?? null,
          onContextConflict: 'start-fresh',
        })
      }
    } catch (err) {
      appendMessage(sessionId, {
        id: `profile_error_${Date.now()}`,
        role: 'system',
        content: `Could not switch profile: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      return
    }
    if (!result.ok) {
      if (result.currentInstanceId !== prevInstanceId) {
        storeSetInstanceId(sessionId, result.currentInstanceId ?? undefined)
      }
      if (result.code !== 'context-unavailable') {
        appendMessage(sessionId, {
          id: `profile_error_${Date.now()}`,
          role: 'system',
          content: `Could not switch profile: ${result.message}`,
          timestamp: Date.now(),
        })
        return
      }
      // No live backend session exists yet. This is the only safe DB-only
      // path; a per-component ref cannot prove liveness in another panel,
      // renderer process, or phone client.
      try {
        await window.api.app.setConversationProviderInstanceId(sessionId, nextInstanceId)
      } catch (err) {
        log.warn('could not save the initial profile', err)
        return
      }
    }
    storeSetInstanceId(sessionId, nextInstanceId)
    // Machine default too, so a phone-started session picks the profile the
    // user actually works with rather than `<agent-type>-default`.
    window.api.settings
      ?.set?.(SETTING_DEFAULT_INSTANCE_ID, nextInstanceId)
      .catch((err: unknown) => log.warn('could not save the default profile', err))
    // Record a rotation marker in the chat stream - only when there's
    // actually a prior conversation to attribute (skip on freshly-opened
    // sessions where the picker is just being set up).
    const hasPriorMessages = (activeSession?.messages?.length ?? 0) > 0
    if (hasPriorMessages && prevInstanceId !== nextInstanceId) {
      const instances = useProviderInstanceStore.getState().instances
      const fromName = instances.find((i) => i.id === prevInstanceId)?.displayName
        ?? prevInstanceId
        ?? 'previous instance'
      const toName = instances.find((i) => i.id === nextInstanceId)?.displayName
        ?? nextInstanceId
        ?? 'default'
      const marker: ChatMessage = {
        id: `rotation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'system',
        content: `${ROTATION_MARKER_PREFIX} ${fromName} → ${toName}`,
        timestamp: Date.now(),
      }
      appendMessage(sessionId, marker)
      window.api.app.saveMessage({
        id: marker.id,
        conversationId: sessionId,
        role: marker.role,
        content: marker.content,
      }).catch(() => {})
    }
    // The new instance may map to a different remote config dir - drop the
    // machine's cached auth verdicts so the banner re-probes under it.
    const machineForSession = useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.machineId
    if (machineForSession && machineForSession !== 'local') invalidateRemoteAuthCache(machineForSession)
  }, [sessionId, storeSetInstanceId, instanceId, activeSession?.messages?.length, appendMessage, agentType])

  // ── Provider event listener (new SDK bridge) ──────────────────

  // Streaming preference + per-panel buffer. Read once on mount; toggle
  // changes take effect on the next session switch. When OFF, content
  // events accumulate in the buffer and flush on turn.completed.
  const streamingEnabledRef = useRef<boolean>(true)
  useEffect(() => {
    isAssistantStreamingEnabled().then((v) => {
      streamingEnabledRef.current = v
    })
  }, [])

  // Streaming-ON path: coalesce cumulative content snapshots to ~30fps
  // before they hit the store (per-token commits re-rendered the streaming
  // bubble per delta). Ordering contract lives in services/contentCoalescer.
  const contentCoalescerRef = useRef<ContentCoalescer | null>(null)
  if (!contentCoalescerRef.current) {
    contentCoalescerRef.current = createContentCoalescer(({ threadId, messageId, text, append }) =>
      upsertAssistantContent(threadId, messageId, { text, append }),
    )
  }
  useEffect(() => () => contentCoalescerRef.current?.dispose(), [])

  useEffect(() => {
    if (!window.api.provider?.onEvent) {
      return
    }

    // onProviderEvent drops cross-machine bleed (same threadId on two machines).
    const removeProvider = onReducedProviderEvent((event) => {
      const tid = event.threadId
      if (!tid) return
      prepareRuntimeEventLifecycle(
        event,
        messageLifecycle,
        (threadId) => contentCoalescerRef.current?.flushThread(threadId),
      )

      switch (event.type) {
        // This canonical event is the only point where Desktop presents the
        // user turn as sent. Mobile outboxes may already have a pending bubble;
        // the shared origin id collapses their accepted echo onto it.
        case 'user.message': {
          if (event.handoffMarker) {
            appendMessage(tid, {
              id: event.handoffMarker.id,
              role: 'system',
              content: event.handoffMarker.text,
              timestamp: event.at - 1,
            })
          }
          const visibleText = visibleUserMessageText(event.text, event.displayBody)
          if (visibleText !== null) {
            appendMessage(tid, {
              id: echoMessageId(event.origin ?? String(event.at)),
              role: 'user',
              content: event.text,
              displayBody: visibleText === event.text ? undefined : visibleText,
              pillsMeta: event.pillsMeta,
              images: event.images,
              timestamp: event.at,
            })
          }
          emitSessionActivity(tid, event.at)
          if (event.conversationTitle) {
            setTitle(tid, event.conversationTitle)
            emitSessionRename(tid, event.conversationTitle)
          }
          if (event.origin) emitUserTurnAccepted(tid, event.origin)
          break
        }
        case 'content': {
          const chunk = { text: event.text, append: event.append }
          if (!streamingEnabledRef.current) {
            bufferContent(streamingBuffer, tid, event.messageId, chunk)
            break
          }
          contentCoalescerRef.current?.push(tid, event.messageId, chunk)
          break
        }
        case 'peer.message': {
          // Both sides render live. The backend persisted the same ids, so
          // appendMessage's id-idempotency collapses the stored row onto this
          // bubble instead of showing the delivery twice after a reload.
          const ownLabel = useAgentStore.getState().sessions.find((s) => s.id === tid)?.title ?? tid
          appendMessage(tid, peerMessageToChatMessage(event, ownLabel))
          break
        }
        case 'tool.started': {
          const existing = useAgentStore.getState().sessions
            .find((s) => s.id === tid)?.messages
            .find((m) => m.toolCalls?.some((tc) => tc.id === event.toolId))
          if (existing) {
            updateMessage(tid, existing.id, {
              toolCalls: existing.toolCalls?.map((tc) => tc.id === event.toolId
                ? { ...tc, name: event.toolName, input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2) }
                : tc),
            })
            break
          }
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
          clearProviderRetry(tid)
          // Flush buffered content if streaming was off this turn.
          if (!streamingEnabledRef.current) {
            const drained = drainTurn(streamingBuffer, tid)
            for (const entry of drained) {
              // The buffer already folded every chunk, so this is the whole
              // body and replaces rather than extends.
              upsertAssistantContent(tid, entry.messageId, { text: entry.text })
            }
          }
          // Token usage comes from context_window events only - this event's
          // usedTokens is input_tokens sans cache reads, misleadingly tiny.
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
              displayedSessionIds: useLayoutStore.getState().displayedChatSessionIds(),
              onClick: () => useLayoutStore.getState().selectChatSession(tid),
            })
          }
          break
        }
        case 'turn.retrying': {
          upsertProviderRetry(tid, event.message)
          break
        }
        case 'context_window': {
          // Real context usage from SDK - reflects compaction too
          useAgentStore.getState().setTokenUsage(tid, {
            usedTokens: event.usedTokens,
            maxTokens: event.maxTokens ?? null,
          })
          // ACP adapters (currently OpenCode) also forward cumulative cost
          // here. Push it onto the session so StatusBar can display it.
          if (typeof event.costUsd === 'number') {
            useAgentStore.getState().setCostUsd(tid, event.costUsd)
          }
          // Lets the picker name the model instead of showing "Default".
          if (event.model) {
            useAgentStore.getState().setResolvedModel(tid, event.model)
          }
          break
        }
        case 'session.provider': {
          useAgentStore.getState().setInstanceId(tid, event.instanceId ?? undefined)
          break
        }
        case 'spend.blocked': {
          // ChatInput warns on this pair before the next send.
          if (event.model) {
            useSpendBlockStore.getState().record({
              instanceId: event.instanceId,
              model: event.model,
              reason: event.reason,
              scope: event.scope,
              resetsAtMs: event.resetsAtMs,
            })
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
        case 'todo.updated': {
          // Replaced in place, not appended: Codex re-sends the whole list on
          // every step change, so appending would stack a card per update.
          const todoMsgId = `todo_${event.todoId}`
          const store = useAgentStore.getState()
          const has = store.sessions.find((s) => s.id === tid)?.messages
            .some((m) => m.id === todoMsgId)
          if (has) {
            updateMessage(tid, todoMsgId, { todos: { id: event.todoId, items: event.items } })
          } else {
            appendMessage(tid, {
              id: todoMsgId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              todos: { id: event.todoId, items: event.items },
            })
          }
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
        case 'file.edited': {
          // One diff card per file changed during the turn (git-checkpoint
          // derived). Coalesce re-edits of the same file within a turn by id.
          const id = `filediff_${event.fileEditId}`
          const sessions = useAgentStore.getState().sessions
          const session = sessions.find((s) => s.id === tid)
          const existing = session?.messages.find((m) => m.id === id)
          const fileDiff = {
            fileEditId: event.fileEditId,
            repoRoot: event.repoRoot,
            relPath: event.relPath,
            changeKind: event.changeKind,
            oldContent: event.oldContent,
            newContent: event.newContent,
            status: 'pending' as const,
          }
          if (existing) {
            updateMessage(tid, id, { fileDiff })
          } else {
            appendMessage(tid, { id, role: 'assistant', content: '', timestamp: Date.now(), fileDiff })
          }
          break
        }
        case 'worktree.drift': {
          // Suggestion only - swapping the pointer is the user's call (three
          // agents in three worktrees would ping-pong an auto-swap). Remote
          // sessions are skipped: the pointer swap would write a remote path
          // into local routing. Already-followed worktrees are skipped too
          // (per-turn re-arm would otherwise re-suggest where you are).
          if (event.machineId && event.machineId !== 'local') break
          const drifted = useAgentStore.getState().sessions.find((s) => s.id === tid)
          if (drifted?.worktreePath === event.worktreePath) break
          useAgentStore.getState().setDriftSuggestion(tid, {
            worktreePath: event.worktreePath,
            branch: event.branch,
          })
          break
        }
        case 'error': {
          clearProviderRetry(tid)
          const errMsg: ChatMessage = {
            id: `error_${Date.now()}`,
            role: 'system',
            content: `Error: ${event.message}`,
            timestamp: Date.now(),
          }
          appendMessage(tid, errMsg)
          // Persisted by the registry, not here: this listener only exists when
          // a desktop window is attached, so a phone talking to a headless
          // server lost the card on reload.
          break
        }
        case 'status': {
          updateStatus(tid, event.status as AgentStatus)
          if (event.status !== 'running') clearProviderRetry(tid)
          break
        }
      }
      finishRuntimeEventLifecycle(event, messageLifecycle)
    })
    return () => removeProvider()
  }, [appendMessage, updateMessage, updateStatus, setTitle])

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
  // Rejections propagate to the card so it can re-enable its buttons.
  const handleApproval = useCallback(async (requestId: string, decision: 'approve' | 'deny', note?: string) => {
    if (!sessionId) return
    try {
      await window.api.provider?.respondToRequest(sessionId, requestId, decision)
    } catch (err) {
      log.warn('respondToRequest failed', { requestId, decision, err })
      appendMessage(sessionId, {
        id: `error_${Date.now()}`,
        role: 'system',
        content: `Failed to ${decision === 'approve' ? 'approve' : 'deny'} the request: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      throw err
    }
    // Queue the note only once the decision landed - a failed decision
    // with a queued note would send a dangling follow-up message.
    if (note) {
      pendingNoteRef.current = { sessionId, text: note }
    }
  }, [sessionId, appendMessage])

  const handleAnswerQuestion = useCallback(async (requestId: string, answers: string[][]) => {
    if (!sessionId) return
    try {
      await window.api.provider?.answerQuestion?.(sessionId, requestId, answers)
    } catch (err) {
      log.warn('answerQuestion failed', { requestId, err })
      appendMessage(sessionId, {
        id: `error_${Date.now()}`,
        role: 'system',
        content: `Failed to submit answer: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      throw err
    }
  }, [sessionId, appendMessage])

  // Rejections propagate to the card, which shows the inline error and
  // stays actionable so the user can retry.
  const handleFileDiffResolve = useCallback(
    async (messageId: string, status: 'accepted' | 'rejected' | 'partial', contentToWrite: string | null) => {
      if (!sessionId) return
      const sess = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
      const fd = sess?.messages.find((m) => m.id === messageId)?.fileDiff
      if (!fd) return
      const persist = () => updateMessage(sessionId, messageId, { fileDiff: { ...fd, status } })
      // 'accepted' = keep the agent's changes; disk already holds them.
      if (contentToWrite === null) {
        persist()
        return
      }
      // Rejecting an agent-*added* file means it shouldn't exist - delete it
      // rather than leaving a stray empty file (matches Cursor's revert).
      const writeBack =
        fd.changeKind === 'add' && status === 'rejected'
          ? window.api.files.deleteFile(fd.repoRoot, fd.relPath)
          : window.api.files.writeFile(fd.repoRoot, fd.relPath, contentToWrite)
      let res: Awaited<typeof writeBack>
      try {
        res = await writeBack
      } catch (err) {
        log.warn('file-diff write-back threw', { relPath: fd.relPath, err })
        throw err
      }
      if (!res.ok) {
        // Don't persist the status - leave the card actionable so the user
        // can retry rather than silently believing the revert landed.
        log.warn('file-diff write-back failed', {
          relPath: fd.relPath,
          conflict: 'conflict' in res ? res.conflict : undefined,
          error: res.error,
        })
        throw new Error(
          'conflict' in res && res.conflict
            ? 'file changed on disk after the diff was captured'
            : res.error,
        )
      }
      persist()
    },
    [sessionId, updateMessage],
  )

  const handlePlanAction = useCallback((_planId: string, action: 'implement' | 'iterate') => {
    if (!sessionId) return
    // Switch session out of plan mode and send an appropriate follow-up
    if (action === 'implement') {
      storeSetRuntimeMode(sessionId, 'sandbox')
      ;window.api.provider?.setRuntimeMode?.(sessionId, 'sandbox').catch((err) => {
        log.warn('setRuntimeMode failed before implementing plan', err)
      })
      setTimeout(() => {
        const text = 'Implement the plan you proposed.'
        void submitProgrammaticTurn(text, handleSend, (_rejectedText, error) => {
          appendMessage(sessionId, {
            id: `error_${Date.now()}`,
            role: 'system',
            content: `Plan implementation was not sent: ${error}`,
            timestamp: Date.now(),
          })
        })
      }, 50)
    } else {
      setTimeout(() => {
        // Focus the chat input so user can iterate on the plan
        focusComposer(sessionId)
      }, 50)
    }
  // handleSend is defined below; safe as long as sessionId/deps are right
  }, [sessionId, storeSetRuntimeMode, appendMessage])

  // Flush a pending approval note once the agent is idle again
  useEffect(() => {
    const pending = pendingNoteRef.current
    if (!pending) return
    if (status !== 'idle') return
    if (pending.sessionId !== sessionId) return
    pendingNoteRef.current = null
    // Send via the existing handleSend path so UI + provider see it
    setTimeout(() => {
      void submitProgrammaticTurn(pending.text, handleSend, (text, error) => {
        useDraftStore.getState().appendDraft(pending.sessionId, text)
        appendMessage(pending.sessionId, {
          id: `error_${Date.now()}`,
          role: 'system',
          content: `Approval note was not sent and was restored to the composer: ${error}`,
          timestamp: Date.now(),
        })
      })
    }, 100)
    // handleSend isn't in deps since we don't want to re-fire - it's called once
  }, [status, sessionId, appendMessage])

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
        origin?: string
        displayBody?: string
        pillsMeta?: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }>
      },
    ): Promise<ChatSendResult> => {
      if (!sessionId) return { accepted: false, error: 'This chat is no longer available.' }

      // `/send-to <session>: <text>` hands the text to another live session
      // instead of this one's agent, so it is intercepted before every other
      // send concern. Rejections stay in the composer so the source text and
      // attachments remain editable.
      const sendTo = parseSendTo(message)
      if (sendTo) {
        const fail = (error: string): ChatSendResult => ({ accepted: false, error })
        if (!sendTo.ok) return fail(sendTo.error)
        if (images && images.length > 0) {
          return fail('Images cannot be sent with /send-to. Send the text on its own.')
        }
        const store = useAgentStore.getState()
        const target = resolveSendToTarget(
          sendTo.target,
          store.sessions.map((s) => ({ id: s.id, title: s.title ?? s.id, machineId: s.machineId })),
          sessionId,
        )
        if (!target.ok) return fail(target.error)
        try {
          await window.api.provider.deliverPeerMessage({
            fromThreadId: sessionId,
            fromLabel: store.sessions.find((s) => s.id === sessionId)?.title ?? sessionId,
            targetThreadId: target.id,
            text: sendTo.text,
          })
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
        return { accepted: true }
      }

      // Prepare sequentially so removing the count cap cannot fan out an
      // unbounded number of canvas/base64 allocations. Validate the growing
      // aggregate after every image and stop as soon as the 3 MiB wire budget
      // is crossed. Nothing below this point may mutate transcript, handoff,
      // provider, or persistence state until this succeeds.
      let messageImages: import('@shared/types').MessageImage[] | undefined
      if (images && images.length > 0) {
        const prepared: import('@shared/types').MessageImage[] = []
        try {
          for (const img of images) {
            let dataUrl: string
            try {
              dataUrl = (await downscaleImage(img.file)).dataUrl
            } catch (err) {
              log.warn('image downscale failed, sending original bytes', err)
              dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result as string)
                reader.onerror = () => reject(reader.error)
                reader.readAsDataURL(img.file)
              })
            }
            const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || img.file.type
            prepared.push({ url: dataUrl, mimeType, name: img.file.name })
            validateUserMessageImages(prepared)
          }
          messageImages = validateUserMessageImages(prepared)
        } catch (error) {
          const imageError = error instanceof Error ? error.message : String(error)
          return { accepted: false, error: imageError }
        }
      }

      // Mid-turn admission happens only after image validation. OpenCode
      // cannot accept another prompt while busy, so keep this draft editable
      // instead of treating an in-memory queue as backend acceptance.
      const liveStatus = useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.status
      const busy = liveStatus === 'running' || liveStatus === 'thinking'
      if (busy && agentType === 'opencode') {
        return {
          accepted: false,
          error: 'OpenCode is still working. Your text and attachments are preserved; send again when it finishes.',
        }
      }

      // Cross-provider context handoff. A pending flag - set by an agent
      // switch over existing history, or by a degraded Codex / OpenCode
      // fork - means the current adapter has never seen the visible
      // transcript. Prefix this turn's wire message with the transcript
      // preamble. The backend clears the flag in the acceptance transaction.
      let wireMessage = message
      let pendingHandoffFrom: string | null = null
      let handoff: UserTurnSubmissionV1['handoff']
      try {
        pendingHandoffFrom = (await window.api.app.getConversationPendingHandoff(sessionId)).from
      } catch (err) {
        log.warn('pending-handoff read failed, sending without preamble', err)
      }
      if (pendingHandoffFrom) {
        // Live read - the closure's `messages` lags in-place streamed edits.
        const history = useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.messages ?? []
        const preamble = buildHandoffPreamble(history)
        if (preamble) {
          wireMessage = `${preamble}\n\n${message}`
          const handoffFrom = pendingHandoffFrom as NonNullable<UserTurnSubmissionV1['handoff']>['expectedFrom']
          const markerText = handoffFrom === agentType
            ? `${CONTEXT_HANDOFF_MARKER_PREFIX} ${agentLabel(agentType)} profile restarted with visible history`
            : `${CONTEXT_HANDOFF_MARKER_PREFIX} ${agentLabel(handoffFrom)} → ${agentLabel(agentType)}`
          if (handoffFrom === 'claude-code'
            || handoffFrom === 'codex'
            || handoffFrom === 'opencode'
            || handoffFrom === 'cursor') {
            handoff = {
              expectedFrom: handoffFrom,
              markerId: '',
              markerText,
            }
          }
        }
      }
      const handoffInjected = wireMessage !== message

      const origin = extras?.origin ?? desktopTurnAttempts.originFor(
        sessionId,
        desktopComposerFingerprint({
          message,
          runtimeMode,
          images: images?.map((image) => ({
            name: image.file.name,
            size: image.file.size,
            type: image.file.type,
            lastModified: image.file.lastModified,
          })),
          extras,
        }),
      )
      if (handoff) handoff.markerId = `handoff_${origin}`

      const turn = desktopPreparedTurns.prepare({
        version: 1,
        threadId: sessionId,
        origin,
        providerText: wireMessage,
        displayBody: handoffInjected ? (extras?.displayBody ?? message) : extras?.displayBody,
        pillsMeta: handoffInjected ? (extras?.pillsMeta ?? {}) : extras?.pillsMeta,
        images: messageImages,
        runtimeMode,
        handoff,
        autoTitleText: message,
      })

      // Start only after image preparation and validation. A definite startup
      // rejection leaves the composer intact and does not create a false user
      // turn or a persisted system bubble.
      const providerApi = window.api.provider
      const providerKind = agentType === 'codex' ? 'codex' : agentType === 'opencode' ? 'opencode' : 'claude'
      const effectiveMode = runtimeMode

      const submissionDependencies: DesktopTurnSubmissionDependencies = {
        startSession: async () => {
          if (providerStartedRef.current.has(sessionId)) return
          providerStartedRef.current.add(sessionId)
          try {
            const sessionForCwd = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
            const linkedCard = useKanbanStore.getState().findByConversationId(sessionId)
            const cwd = sessionForCwd?.worktreePath ?? linkedCard?.worktreePath ?? projectPath ?? '.'
            window.api.routing.bind(sessionId, sessionForCwd?.machineId ?? 'local')
            await providerApi.startSession({
              threadId: sessionId,
              provider: providerKind,
              cwd,
              runtimeMode: effectiveMode,
              resumeSessionId,
              model: model || undefined,
              reasoningEffort,
              instanceId,
            })
          } catch (error) {
            providerStartedRef.current.delete(sessionId)
            updateStatus(sessionId, 'idle')
            throw error
          }
        },
        submit: (submission) => providerApi.submitUserTurn(submission),
      }
      let outcome = await submitDesktopUserTurn(turn, submissionDependencies)
      if (!outcome.accepted && outcome.recoveryOrigin) {
        const recoveryOrigin = outcome.recoveryOrigin
        const recoveringCurrentTurn = recoveryOrigin === origin
        const confirmed = window.confirm(
          recoveringCurrentTurn
            ? 'Delivery is unconfirmed and the agent may already have received this message. Continue without resending it?'
            : 'An earlier message has unconfirmed delivery and is blocking this send. Continue without resending the earlier message?',
        )
        if (confirmed) {
          const resolution = await providerApi.resolveUserTurn({
            version: 1,
            threadId: sessionId,
            origin: recoveryOrigin,
            action: 'abandon',
          })
          if (resolution.status === 'abandoned' || resolution.status === 'completed') {
            if (recoveringCurrentTurn) {
              if (resolution.status === 'abandoned') {
                desktopTurnAttempts.accept(sessionId, recoveryOrigin)
                desktopPreparedTurns.accept(sessionId, recoveryOrigin)
                appendMessage(sessionId, {
                  id: `turn_abandoned_${recoveryOrigin}`,
                  role: 'system',
                  content: 'Unconfirmed message was not resent. Delivery may already have occurred.',
                  timestamp: Date.now(),
                })
                return { accepted: true }
              }
              // Replay the completed origin so the backend republishes its
              // canonical event if the original response and event were lost.
              outcome = await submitDesktopUserTurn(turn, submissionDependencies)
            } else {
              desktopTurnAttempts.accept(sessionId, recoveryOrigin)
              desktopPreparedTurns.accept(sessionId, recoveryOrigin)
              outcome = await submitDesktopUserTurn(turn, submissionDependencies)
            }
          } else {
            return { accepted: false, error: resolution.reason }
          }
        }
      }
      if (outcome.accepted) {
        desktopTurnAttempts.accept(sessionId, origin)
        desktopPreparedTurns.accept(sessionId, origin)
        return { accepted: true }
      }
      return { accepted: false, error: outcome.error }
    },
    // `instanceId`, `model`, `reasoningEffort` matter on the FIRST send
    // after a session restart (e.g. instance chip switch resets
    // providerStartedRef, so the next send re-spawns with new opts). Without
    // these in the deps, the captured closure stays on the prior values and
    // the new session boots under the old credentials - visible as "instance
    // switch had no effect" in the registry log.
    [sessionId, agentType, projectPath, runtimeMode, appendMessage, messages.length, resumeSessionId, setTitle, instanceId, model, reasoningEffort],
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

  // ⌘F intercept - uses a document-level capture listener instead of an
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
      // steal - that panel's listener will handle it.
      const inAnyChatPanel = !!active && !!active.closest('[data-chat-panel="true"]')
      // If focus is inside a terminal (xterm), the terminal pane will
      // claim ⌘F via its own listener - bail so we don't double-trigger.
      const inTerminal = !!active && (
        active.classList.contains('xterm-helper-textarea') ||
        !!active.closest('.xterm') ||
        !!active.closest('[data-terminal-pane="true"]')
      )
      // If focus is inside the CM6 file editor, let it handle ⌘F natively
      // via its own searchKeymap binding - bail so we don't steal it.
      const inFileViewer = !!active && !!active.closest('[data-context-source="file-viewer"]')
      if (inTerminal || inFileViewer) return
      if (!inThisPanel) {
        if (inAnyChatPanel) return
        // Focus is somewhere neutral (body, sidebar, etc). Only the
        // "default" (active-session) panel should claim ⌘F so dual-chat
        // doesn't double-trigger.
        const isDefault = chatSlot === 'primary' || (chatSlot == null && sessionIdOverride == null)
        if (!isDefault) return
      }
      e.preventDefault()
      e.stopPropagation()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [sessionIdOverride, chatSlot])

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
      data-chat-slot={chatSlot}
      data-session-id={sessionId ?? undefined}
      data-focused={showFocusIndicator ? isVisiblyFocused : undefined}
      onFocusCapture={focusSlot}
      onPointerDown={focusSlot}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'var(--bg-primary)',
        position: 'relative',
        boxShadow: isVisiblyFocused
          ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 46%, transparent)'
          : undefined,
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
        className="chat-panel-header"
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
        {/* Plain identity breadcrumb; only consequential state receives color. */}
        {hasSession ? (
          <div className="chat-identity" title={projectPath}>
            {identity.breadcrumb.slice(0, -1).map((part, index) => (
              <span className="chat-identity-parent" key={`${part}-${index}`}>
                {part}<span className="chat-identity-separator">/</span>
              </span>
            ))}
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
              <span className="chat-identity-title" title={chatTitle}>{chatTitle}</span>
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
            {identity.branch && (
              <span className="chat-identity-branch" title={activeSession?.worktreePath ?? identity.branch}>
                {identity.branch}
              </span>
            )}
          </div>
        ) : (
          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>Switchboard</span>
        )}

        <span style={{ flex: 1 }} />

        {otherSessionId && (
          <button
            type="button"
            onClick={copyPromptToOtherChat}
            disabled={!hasDraftPayload}
            aria-label="Copy prompt to other chat"
            title="Copy this draft and its attachments to the other chat for comparison"
            className="chat-header-action"
          >
            Copy prompt → other
          </button>
        )}

        {onOpenBeside && (
          <button
            type="button"
            onClick={onOpenBeside}
            aria-label="Open beside"
            title="Compare or delegate with two chats side by side"
            className="chat-header-action"
          >
            Open beside
          </button>
        )}

        {/* Right-panel close button (only shown when this is the secondary
            panel in dual-chat mode - passed via `onClose` prop) */}
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

      {activeSession?.forkMetadata && (
        <ForkLineageBanner metadata={activeSession.forkMetadata} />
      )}

      {/* Messages */}
      <MessageList
        messages={messages}
        sessionId={sessionId}
        agentType={activeSession?.type ?? agentType}
        onApproval={handleApproval}
        onAnswerQuestion={handleAnswerQuestion}
        onPlanAction={handlePlanAction}
        onFileDiffResolve={handleFileDiffResolve}
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

      {/* Remote-auth preflight - warns at chat-open when this session's VM
          has no Claude credentials, instead of erroring at first send.
          Non-blocking; the START_SESSION backstop still guards the race. */}
      <RemoteAuthBanner
        sessionId={sessionId}
        machineId={activeSession?.machineId}
        agentType={agentType}
        instanceId={instanceId}
      />

      {/* Input - now includes runtime mode + context meter in footer */}
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
        instanceId={instanceId}
        onInstanceChange={handleInstanceChange}
        canChangeAgent={
          // Allow switching agent unless a turn is actively running. We
          // tear down the old provider session on switch so the next send
          // cleanly spins up a fresh one under the new provider.
          !hasSession || (status !== 'running' && status !== 'thinking')
        }
        runtimeMode={runtimeMode}
        onRuntimeModeChange={handleRuntimeModeChange}
        model={model}
        resolvedModel={resolvedModel}
        onModelChange={handleModelChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={handleReasoningEffortChange}
        contextUsage={hasSession ? {
          // Rough approximation: ~4 chars per token. Real data arrives via turn.completed events.
          usedTokens: activeSession?.tokenUsage?.usedTokens || estimatedTokens,
          maxTokens: activeSession?.tokenUsage?.maxTokens ?? 200000,
        } : undefined}
        isRunning={status === 'running' || status === 'thinking'}
        onInterrupt={async () => {
          if (!sessionId) return
          // No provider session was ever started (e.g. startSession failed) -
          // there is nothing in main to interrupt and no event will ever
          // arrive, so clear the stuck status locally instead of no-oping.
          if (!providerStartedRef.current.has(sessionId)) {
            messageLifecycle.settleThread(sessionId)
            updateStatus(sessionId, 'idle')
            return
          }
          try {
            await window.api.provider?.interrupt?.(sessionId)
            contentCoalescerRef.current?.flushThread(sessionId)
            messageLifecycle.settleThread(sessionId)
          } catch (err) {
            log.warn('provider interrupt failed; stopping wedged session', { sessionId, err })
            await window.api.provider?.stopSession?.(sessionId).catch((stopErr: unknown) => {
              log.warn('provider recovery stop failed', { sessionId, err: stopErr })
            })
            providerStartedRef.current.delete(sessionId)
            agentStartedRef.current.delete(sessionId)
            contentCoalescerRef.current?.flushThread(sessionId)
            messageLifecycle.settleThread(sessionId)
            updateStatus(sessionId, 'idle')
          }
        }}
        onClearMessages={() => {
          if (!sessionId) return
          contentCoalescerRef.current?.flushThread(sessionId)
          messageLifecycle.settleThread(sessionId)
          clearMessages(sessionId)
        }}
        onArchive={() => {
          if (!sessionId) return
          messageLifecycle.settleThread(sessionId)
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
