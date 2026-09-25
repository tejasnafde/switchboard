import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useAgentStore, type RuntimeMode } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import { useMachineStore } from '../../stores/machine-store'
import { ROTATION_MARKER_PREFIX, AGENT_SWITCH_MARKER_PREFIX, CONTEXT_HANDOFF_MARKER_PREFIX } from './rotation-marker'
import { buildHandoffPreamble, nextPendingHandoffFrom } from '@shared/handoff'
import { parseSendTo, resolveSendToTarget } from './send-to-command'
import { reduceProviderEvent, upsertAssistantContent } from './provider-event-reducer'
import { MessageList } from './MessageList'
import { changeModel, changeReasoningEffort, changeRuntimeMode } from './chat-session-settings'
import { useChatSearch } from './useChatSearch'
import { SlashHelpOverlay } from './SlashHelpOverlay'
import { ChatInput, type ChatSendResult } from './ChatInput'
import { chatIdentity } from './chat-identity'
import { RemoteAuthBanner, invalidateRemoteAuthCache } from './RemoteAuthBanner'
import { ForkLineageBanner } from './ForkLineageBanner'
import { CompactionOfferBanner } from './CompactionOfferBanner'
import { shouldOfferCompaction } from '@shared/compaction-offer'
import { isDraftSessionId } from '@shared/new-chat-draft'
import { runningPlaceholder } from '@shared/turn-delivery'
import { materializeDraft, takeFirstSend } from '../../services/draft-chat'
import { ContextWindowMeter } from './ContextWindowMeter'
import {
  onSessionRename,
  emitSessionRename,
  onReducedProviderEvent,
} from '../../services/session-events'
import { isAssistantStreamingEnabled } from '../../services/streaming-pref'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:panel')
import { createContentCoalescer, type ContentCoalescer } from '../../services/content-coalescer'
import {
  finishRuntimeEventLifecycle,
  messageLifecycle,
  prepareRuntimeEventLifecycle,
} from '../../services/message-lifecycle'
import {
  validateUserMessageImages,
  type UserTurnSubmissionV1,
} from '@shared/provider-events'
import {
  desktopComposerFingerprint,
  desktopPreparedTurns,
  desktopRecoveryResolutionAllowsSend,
  desktopTurnAttempts,
  pendingDesktopUserMessage,
  shouldRetainPreparedDesktopTurn,
  submitProgrammaticTurn,
  submitDesktopUserTurn,
  type DesktopTurnSubmissionDependencies,
} from '../../services/desktop-turn-submission'
import { downscaleImage } from '../../services/image-downscale'
import { InPaneSearchBar } from '../InPaneSearchBar'
import { defaultInstanceId, agentLabel, type AgentType, type ChatMessage } from '@shared/types'
import { defaultInstanceSettingKey } from '@shared/session-defaults'
import { useLayoutStore } from '../../stores/layout-store'
import type { ChatSlot } from '../../services/chat-workspace'
import { focusComposer } from '../../services/composer-registry'
import {
  cloneDraftPayload,
  requiresDraftTransferConfirmation,
  withDraftProvenance,
} from '../../services/draft-transfer'
import { providerKindFor } from '@shared/types'
import { confirm } from '../ui/confirm'
import { isSyntheticOnlyMessage } from './SyntheticUserRow'

interface ChatPanelProps {
  /**
   * Override the session this panel renders. Legacy unslotted callers fall
   * back to the primary mirror; an explicit slot with no binding stays empty.
   */
  sessionIdOverride?: string | null
  chatSlot?: ChatSlot
  visible?: boolean
  showFocusIndicator?: boolean
  /** Optional close button for the right-hand panel in dual mode. */
  onClose?: () => void
  onOpenBeside?: () => void
}

function slotSessions(
  state: { primarySessionId: string | null; secondarySessionId: string | null },
  chatSlot: ChatSlot | undefined,
): { own: string | null; other: string | null } {
  if (chatSlot === 'primary') return { own: state.primarySessionId, other: state.secondarySessionId }
  if (chatSlot === 'secondary') return { own: state.secondarySessionId, other: state.primarySessionId }
  return { own: null, other: null }
}

export function ChatPanel({ sessionIdOverride, chatSlot, visible = true, showFocusIndicator = false, onClose, onOpenBeside }: ChatPanelProps = {}) {
  const [agentType, setAgentType] = useState<AgentType>('claude-code')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const slotSessionId = useLayoutStore((state) => slotSessions(state, chatSlot).own)
  const focusedChatSlot = useLayoutStore((state) => state.focusedChatSlot)
  const focusChatSlot = useLayoutStore((state) => state.focusChatSlot)
  const followUpDefault = useLayoutStore((state) => state.followUpDefault)
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
  const storeSetAgentType = useAgentStore((s) => s.setAgentType)
  const storeSetInstanceId = useAgentStore((s) => s.setInstanceId)
  const clearMessages = useAgentStore((s) => s.clearMessages)
  const removeSession = useAgentStore((s) => s.removeSession)
  const providerStartedRef = useRef<Set<string>>(new Set())
  const pendingNoteRef = useRef<{ sessionId: string; text: string } | null>(null)
  const agentStartedRef = useRef<Set<string>>(new Set())
  const [slashHelpOpen, setSlashHelpOpen] = useState(false)


  const messages = activeSession?.messages ?? []
  const status = activeSession?.status ?? 'idle'

  // Compaction nudge. A one-minute tick is what lets the banner appear on a
  // pane the user left alone for over an hour, since nothing else re-renders it.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const [compactionDismissedFor, setCompactionDismissedFor] = useState<string | null>(null)
  const offerCompaction = activeSession?.id !== compactionDismissedFor && shouldOfferCompaction({
    provider: activeSession?.type,
    usedTokens: activeSession?.tokenUsage?.usedTokens,
    lastMessageAt: messages.length ? messages[messages.length - 1].timestamp : undefined,
    busy: status === 'running' || status === 'thinking',
    now,
  })
  const pendingDeliveryState = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      // A task notice landing mid-send is not the send.
      if (message.role === 'user' && !isSyntheticOnlyMessage(message)) return message.deliveryState
    }
    return undefined
  }, [messages])
  const hasSession = activeSession !== undefined
  const sessionId = activeSession?.id ?? null
  const projectPath = activeSession?.projectPath
  const resumeSessionId = activeSession?.resumeSessionId
  const chatTitle = activeSession?.title ?? 'New conversation'
  const otherSessionId = useLayoutStore((state) => slotSessions(state, chatSlot).other)
  const hasDraftPayload = useDraftStore((state) => Boolean(sessionId && (
    state.drafts[sessionId]
    || state.pillsBySession[sessionId]?.length
    || state.imagesBySession[sessionId]?.length
  )))
  const focusSlot = useCallback(() => {
    if (chatSlot) focusChatSlot(chatSlot)
  }, [chatSlot, focusChatSlot])
  const isVisiblyFocused = showFocusIndicator && chatSlot === focusedChatSlot
  const copyPromptToOtherChat = useCallback(async () => {
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
    const [title, body] = [
      targetHasDraft ? 'Replace the other chat’s existing draft?' : '',
      crossesBoundary ? 'This copies prompt context across a machine or provider profile boundary.' : '',
    ].filter(Boolean)
    if (title && !(await confirm({ title, body, confirmLabel: 'Copy' }))) return
    // Either panel can switch chats while the dialog is open.
    const now = slotSessions(useLayoutStore.getState(), chatSlot)
    if ((sessionIdOverride ?? now.own) !== sessionId || now.other !== otherSessionId) return
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
  }, [activeSession, chatSlot, chatTitle, otherSessionId, sessionId, sessionIdOverride])
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
    changeRuntimeMode(sessionId, mode)
  }, [sessionId])

  const handleModelChange = useCallback((m: string) => {
    if (!sessionId) return
    changeModel(sessionId, agentType, m)
    // `agentType` is read above, so it belongs here: without it the callback
    // keeps the agent it was created with and files the model under the wrong
    // one after a provider switch.
  }, [sessionId, agentType])

  const handleReasoningEffortChange = useCallback((effort: 'low' | 'medium' | 'high') => {
    if (!sessionId) return
    changeReasoningEffort(sessionId, effort)
  }, [sessionId])

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
      }).catch((err) => {
        log.warn(`failed to persist agent-swap marker for ${sessionId}`, err)
      })
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
    await window.api.provider?.stopSession?.(sessionId).catch((err) => {
      log.warn(`stopSession failed for ${sessionId} during agent switch`, err)
    })
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
        const startFresh = await confirm({
          title: result.message,
          body: 'The current profile is still active. Start the selected profile as a fresh native session and carry the visible conversation into the next turn?',
          confirmLabel: 'Start fresh',
        })
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
    // user actually works with rather than `<agent-type>-default`. Scoped to
    // this agent - the unscoped key used to hand a Codex pick to the next
    // Claude/OpenCode session that started with no instance of its own.
    window.api.settings
      ?.set?.(defaultInstanceSettingKey(agentType), nextInstanceId)
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
      }).catch((err) => {
        log.warn(`failed to persist instance-rotation marker for ${sessionId}`, err)
      })
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

      reduceProviderEvent(event, {
        streamingEnabled: streamingEnabledRef.current,
        coalescer: contentCoalescerRef.current,
      })
      finishRuntimeEventLifecycle(event, messageLifecycle)
    })
    return () => removeProvider()
  }, [])

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
      const persist = () => {
        updateMessage(sessionId, messageId, { fileDiff: { ...fd, status } })
        window.api.app.setFileDiffStatus(sessionId, messageId, status).catch((err) => {
          log.warn('failed to store the file-diff decision', { relPath: fd.relPath, err })
        })
      }
      // 'accepted' = keep the agent's changes; disk already holds them.
      if (contentToWrite === null) {
        persist()
        return
      }
      // Rejecting an agent-*added* file means it shouldn't exist - delete it
      // rather than leaving a stray empty file (matches Cursor's revert).
      // Only over what the agent wrote: a card reopened from history may be
      // older than later edits to the same file.
      const writeBack =
        fd.changeKind === 'add' && status === 'rejected'
          ? window.api.files.deleteFile(fd.repoRoot, fd.relPath, { content: fd.newContent })
          : window.api.files.writeFile(fd.repoRoot, fd.relPath, contentToWrite, undefined, {
              content: fd.changeKind === 'delete' ? null : fd.newContent,
            })
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
      window.api.app.renameConversation(sessionId, trimmed).catch((err) => {
        log.warn(`renameConversation failed for ${sessionId} - optimistic title may not persist`, err)
      })
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
  // The first message of a chat that started as a draft. Sent once, through
  // the ordinary path, by whichever pane shows the new session first.
  const handleSendRef = useRef<typeof handleSend | null>(null)
  useEffect(() => {
    if (!sessionId || isDraftSessionId(sessionId)) return
    const parked = takeFirstSend(sessionId)
    if (!parked) return
    useDraftStore.getState().clearDraft(parked.draftId)
    // The draft id is reused by the next draft for this project, so terminals
    // opened in this one must go with it rather than reappear there.
    // They are closed, not moved: moving is only right for a project checkout.
    useTerminalStore.getState().clearSessionLayout(parked.draftId)
    useAgentStore.getState().removeSession(parked.draftId)
    void handleSendRef.current?.(parked.message, undefined, parked.images, parked.extras).then((result) => {
      if (result.accepted) return
      if (!useDraftStore.getState().getDraft(sessionId)) useDraftStore.getState().setDraft(sessionId, parked.message)
      log.warn('first send from draft was not accepted', result.error)
    })
  }, [sessionId])

  const handleSend = useCallback(
    async (
      message: string,
      delivery?: string,
      images?: Array<{ file: File; previewUrl: string }>,
      extras?: {
        origin?: string
        confirmedRecoveryOrigin?: string
        displayBody?: string
        pillsMeta?: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }>
      },
    ): Promise<ChatSendResult> => {
      if (!sessionId) return { accepted: false, error: 'This chat is no longer available.' }
      // A draft has no conversation yet: the first send creates one and the
      // message follows it there (services/draftChat).
      if (isDraftSessionId(sessionId)) {
        return materializeDraft(sessionId, { message, images, extras })
      }

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
          store.sessions.filter((s) => !s.draft).map((s) => ({ id: s.id, title: s.title ?? s.id, machineId: s.machineId })),
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
      // A queued send is held by the backend until the turn ends, so it may pass.
      if (busy && agentType === 'opencode' && delivery !== 'queue') {
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
        // The backend holds a queued message until the running turn ends.
        ...(delivery === 'queue' ? { delivery: 'queue' as const } : {}),
      })

      // Immediate but honest feedback: this row is keyed exactly like the
      // canonical echo, yet remains renderer-only and visibly pending until
      // the backend commits acceptance. A cold provider start can take over a
      // second (and longer remotely), so withholding all feedback made idle
      // sends look queued or lost.
      const pendingMessage = pendingDesktopUserMessage(turn)

      // Start only after image preparation and validation. A definite startup
      // rejection leaves the composer intact and does not create a false user
      // turn or a persisted system bubble.
      const providerApi = window.api.provider
      const providerKind = providerKindFor(agentType)
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
      const confirmedRecoveryOrigin = extras?.confirmedRecoveryOrigin
      if (confirmedRecoveryOrigin && confirmedRecoveryOrigin !== origin) {
        let resolution
        try {
          resolution = await providerApi.resolveUserTurn({
            version: 1,
            threadId: sessionId,
            origin: confirmedRecoveryOrigin,
            action: 'abandon',
          })
        } catch (error) {
          return {
            accepted: false,
            error: `Could not resolve unconfirmed delivery: ${error instanceof Error ? error.message : String(error)}`,
            delivery: 'ambiguous',
            recoveryOrigin: confirmedRecoveryOrigin,
          }
        }
        if (!desktopRecoveryResolutionAllowsSend(resolution.status)) {
          return {
            accepted: false,
            error: 'reason' in resolution ? resolution.reason : 'The earlier delivery is still unresolved.',
            delivery: 'ambiguous',
            recoveryOrigin: confirmedRecoveryOrigin,
          }
        }
        if (resolution.status === 'completed') {
          const recoveredTurn = desktopPreparedTurns.get(sessionId, confirmedRecoveryOrigin)
          if (recoveredTurn) {
            const replay = await submitDesktopUserTurn(recoveredTurn, submissionDependencies)
            if (!replay.accepted) {
              return {
                accepted: false,
                error: replay.error,
                delivery: replay.delivery === 'pending' || replay.delivery === 'ambiguous'
                  ? 'ambiguous'
                  : 'rejected',
                recoveryOrigin: confirmedRecoveryOrigin,
              }
            }
          }
        }
        desktopTurnAttempts.accept(sessionId, confirmedRecoveryOrigin)
        desktopPreparedTurns.accept(sessionId, confirmedRecoveryOrigin)
      }

      // Reconcile an explicitly confirmed older delivery before inserting the
      // new optimistic row. A completed recovery can replay its canonical
      // echo, and transcript order must remain old turn then new turn.
      const pendingAlreadyExists = useAgentStore.getState().sessions
        .find((session) => session.id === sessionId)?.messages
        .some((candidate) => candidate.id === pendingMessage.id)
      if (pendingAlreadyExists) {
        updateMessage(sessionId, pendingMessage.id, pendingMessage)
      } else {
        appendMessage(sessionId, pendingMessage)
      }

      let outcome = await submitDesktopUserTurn(turn, submissionDependencies)
      if (!outcome.accepted && outcome.recoveryOrigin && outcome.recoveryOrigin !== origin) {
        const recoveryOrigin = outcome.recoveryOrigin
        const confirmed = extras?.confirmedRecoveryOrigin === recoveryOrigin || await confirm({
          title: 'An earlier message has unconfirmed delivery and is blocking this send.',
          body: 'Continue without resending the earlier message?',
          confirmLabel: 'Continue',
        })
        if (confirmed) {
          let resolution
          try {
            resolution = await providerApi.resolveUserTurn({
              version: 1,
              threadId: sessionId,
              origin: recoveryOrigin,
              action: 'abandon',
            })
          } catch (error) {
            useAgentStore.getState().removeMessage(sessionId, pendingMessage.id)
            return {
              accepted: false,
              error: `Could not resolve unconfirmed delivery: ${error instanceof Error ? error.message : String(error)}`,
              delivery: 'ambiguous',
              recoveryOrigin,
            }
          }
          if (desktopRecoveryResolutionAllowsSend(resolution.status)) {
            // The recovered origin may be this pending row or an older row
            // blocking the new send. Preserve an abandoned attempt without
            // falsely presenting it as accepted; a completed record is
            // authoritative acceptance.
            desktopTurnAttempts.accept(sessionId, recoveryOrigin)
            desktopPreparedTurns.accept(sessionId, recoveryOrigin)
            outcome = await submitDesktopUserTurn(turn, submissionDependencies)
          } else {
            useAgentStore.getState().removeMessage(sessionId, pendingMessage.id)
            return {
              accepted: false,
              error: 'reason' in resolution ? resolution.reason : 'The earlier delivery is still unresolved.',
              delivery: 'ambiguous',
              recoveryOrigin,
            }
          }
        }
      }
      if (outcome.accepted) {
        // The accepted result is itself authoritative. Usually the canonical
        // event has already reconciled this row, but clearing here also covers
        // a renderer event lost between backend commit and IPC delivery.
        updateMessage(sessionId, pendingMessage.id, {
          deliveryState: undefined,
          timestamp: outcome.result.acceptedAt,
        })
        desktopTurnAttempts.accept(sessionId, origin)
        desktopPreparedTurns.accept(sessionId, origin)
        return { accepted: true }
      }
      if (!shouldRetainPreparedDesktopTurn(outcome.delivery)) {
        desktopTurnAttempts.accept(sessionId, origin)
        desktopPreparedTurns.accept(sessionId, origin)
      }
      useAgentStore.getState().removeMessage(sessionId, pendingMessage.id)
      return {
        accepted: false,
        error: outcome.error,
        delivery: shouldRetainPreparedDesktopTurn(outcome.delivery) ? 'ambiguous' : 'rejected',
      }
    },
    // `instanceId`, `model`, `reasoningEffort` matter on the FIRST send
    // after a session restart (e.g. instance chip switch resets
    // providerStartedRef, so the next send re-spawns with new opts). Without
    // these in the deps, the captured closure stays on the prior values and
    // the new session boots under the old credentials - visible as "instance
    // switch had no effect" in the registry log.
    [sessionId, agentType, projectPath, runtimeMode, appendMessage, updateMessage, messages.length, resumeSessionId, setTitle, instanceId, model, reasoningEffort],
  )
  handleSendRef.current = handleSend

  const {
    panelRef,
    searchOpen,
    chatSearchMatchInfo,
    handleChatSearchQuery,
    handleChatSearchNext,
    handleChatSearchPrev,
    handleChatSearchClose,
  } = useChatSearch({ messages, sessionId, sessionIdOverride, chatSlot })

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
          <span style={{ color: status === 'error' ? 'var(--error, #f85149)' : 'var(--text-muted)', fontSize: '11px', fontWeight: 400 }}>
            {activeSession?.draft
              ? status === 'running' ? 'creating…' : 'draft'
              : status === 'running'
                ? 'thinking…'
                : status === 'idle' && pendingDeliveryState === 'pending'
                  ? 'sending…'
                  : status === 'idle' ? 'ready' : status}
          </span>
        )}
      </div>

      {activeSession?.forkMetadata && (
        <ForkLineageBanner metadata={activeSession.forkMetadata} />
      )}

      {offerCompaction && activeSession && (
        <CompactionOfferBanner
          usedTokens={activeSession.tokenUsage?.usedTokens ?? 0}
          onCompact={() => { void handleSend('/compact') }}
          onDismiss={() => setCompactionDismissedFor(activeSession.id)}
        />
      )}

      {/* Messages */}
      <MessageList
        messages={messages}
        sessionId={sessionId}
        visible={visible}
        busy={status === 'running' || status === 'thinking'}
        agentType={activeSession?.type ?? agentType}
        onApproval={handleApproval}
        onAnswerQuestion={handleAnswerQuestion}
        onPlanAction={handlePlanAction}
        onFileDiffResolve={handleFileDiffResolve}
      />

      {/* Thinking indicator */}
      {(status === 'running' || status === 'thinking' || pendingDeliveryState === 'pending') && (
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
          <span>{pendingDeliveryState === 'pending' && status === 'idle'
            ? 'Sending…'
            : status === 'thinking' ? 'Thinking…' : 'Working…'}</span>
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
                ? runningPlaceholder(activeSession?.type, followUpDefault)
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
        contextUsage={hasSession && activeSession?.tokenUsage ? {
          // Hidden until the first context_window event: the char estimate read "0" for every fresh chat.
          usedTokens: activeSession.tokenUsage.usedTokens,
          maxTokens: activeSession.tokenUsage.maxTokens ?? 200000,
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
          window.api.app.archiveConversation(sessionId, projectPath, chatTitle).catch((err) => {
            log.warn(`archiveConversation failed for ${sessionId}`, err)
          })
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
