import type { RuntimeEvent } from '@shared/provider-events'
import { splitSyntheticUserText, taskNotificationText, transcriptShowsTaskNotification } from '@shared/synthetic-message'
import { applyContentText, type ContentChunk } from '@shared/content-stream'
import { fileDiffRowId, toolInputText, toolRowId } from '@shared/turn-activity'
import { defaultModelSettingKey } from '@shared/session-defaults'
import { followSuggestionView } from '@shared/follow-suggestions'
import type { AgentStatus, ChatMessage } from '@shared/types'
import { useAgentStore } from '../../stores/agent-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useSpendBlockStore } from '../../stores/spend-block-store'
import { bufferContent, createStreamingBuffer, drainTurn } from '../../services/streaming-buffer'
import type { ContentCoalescer } from '../../services/content-coalescer'
import { acceptedDesktopUserMessage } from '../../services/desktop-turn-submission'
import { emitSessionActivity, emitSessionRename, emitUserTurnAccepted } from '../../services/session-events'
import { notifyTurnCompleted } from '../../services/notifications'
import { createRendererLogger } from '../../logger'
import { peerMessageToChatMessage } from './send-to-command'
import { clearProviderRetry, upsertProviderRetry } from './provider-retry'

const log = createRendererLogger('chat:panel')

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
export function upsertAssistantContent(threadId: string, messageId: string, chunk: ContentChunk): void {
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

export interface ProviderEventContext {
  /** When false, content accumulates in the window-wide buffer until turn.completed. */
  streamingEnabled: boolean
  coalescer: ContentCoalescer | null
}

/** Desktop's reducer from one provider event to agent-store (and side-effect) updates. */
export function reduceProviderEvent(event: RuntimeEvent, ctx: ProviderEventContext): void {
  const tid = event.threadId
  const { appendMessage, updateMessage, updateStatus, setTitle } = useAgentStore.getState()
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
      const acceptedMessage = acceptedDesktopUserMessage(event)
      if (acceptedMessage) {
        const existing = useAgentStore.getState().sessions
          .find((session) => session.id === tid)?.messages
          .some((message) => message.id === acceptedMessage.id)
        if (existing) {
          updateMessage(tid, acceptedMessage.id, {
            ...acceptedMessage,
            deliveryState: undefined,
          })
        } else {
          appendMessage(tid, acceptedMessage)
        }
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
      if (!ctx.streamingEnabled) {
        bufferContent(streamingBuffer, tid, event.messageId, chunk)
        break
      }
      ctx.coalescer?.push(tid, event.messageId, chunk)
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
    case 'task.notification': {
      // The transcript's copy is a user line, so this is one too: MessageBubble
      // splits both into the same row, and a reload replaces this one. A replay
      // after that reload must not add it back beside the transcript row.
      const transcriptRows = (useAgentStore.getState().sessions.find((s) => s.id === tid)?.messages ?? [])
        .filter((m) => m.role === 'user' && !m.id.startsWith('task_'))
        .flatMap((m) => (splitSyntheticUserText(m.content)?.parts ?? []).map((part) => ({ part, at: m.timestamp })))
      if (transcriptShowsTaskNotification(transcriptRows, event)) break
      appendMessage(tid, { id: event.messageId, role: 'user', content: taskNotificationText(event), timestamp: event.at })
      break
    }
    case 'tool.started': {
      const existing = useAgentStore.getState().sessions
        .find((s) => s.id === tid)?.messages
        .find((m) => m.toolCalls?.some((tc) => tc.id === event.toolId))
      if (existing) {
        updateMessage(tid, existing.id, {
          toolCalls: existing.toolCalls?.map((tc) => tc.id === event.toolId
            ? { ...tc, name: event.toolName, input: toolInputText(event.input) }
            : tc),
        })
        break
      }
      appendMessage(tid, {
        id: toolRowId(tid, event.toolId),
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: event.toolId,
          name: event.toolName,
          input: toolInputText(event.input),
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
      if (!ctx.streamingEnabled) {
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
    case 'model.unavailable': {
      // The adapter already switched to the default; clear the stored pick
      // so reopening the chat does not bring the retired model back. A
      // newer pick made before this event arrived is left alone.
      const current = useAgentStore.getState().sessions.find((s) => s.id === tid)
      if (current?.model === event.model) {
        useAgentStore.getState().setModel(tid, '')
        window.api.app.setConversationModel?.(tid, '').catch((err: unknown) => log.warn('clear retired model failed', err))
      }
      // And the machine default, or every new chat would start on it again.
      if (current && current.type !== 'terminal') {
        const key = defaultModelSettingKey(current.type)
        void window.api.settings?.get?.(key).then((stored: string | null) => {
          if (stored === event.model) return window.api.settings?.set?.(key, '')
        }).catch((err: unknown) => log.warn('clear retired default model failed', err))
      }
      appendMessage(tid, {
        id: `model_unavailable_${Date.now()}`,
        role: 'system',
        content: `${event.model} is not available on this account any more. This chat now uses the default model.`,
        timestamp: Date.now(),
      })
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
      const id = fileDiffRowId(event.fileEditId)
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
    case 'session.execution-root-changed': {
      // The backend COMMITTED a move: the provider is already running
      // there. Unlike `worktree.drift` this is not a suggestion, and unlike
      // the old pointer write it is revision-guarded, so a late event from
      // a client that was asleep cannot drag the chip backwards.
      useAgentStore.getState().applyExecutionRoot(tid, {
        path: event.to.path,
        branch: event.to.branch,
        revision: event.revision,
        isWorktree: event.to.isWorktree,
      })
      break
    }
    case 'worktree.drift': {
      // Suggestion only - swapping the pointer is the user's call (three
      // agents in three worktrees would ping-pong an auto-swap).
      // Already-followed worktrees are skipped (per-turn re-arm would
      // otherwise re-suggest where you are).
      //
      // Remote sessions used to be dropped here, because following meant
      // writing a remote absolute path into local routing. Relocation is
      // now a request to the backend that OWNS the path: this renderer
      // holds the suggestion, hands it straight back to the same machine,
      // and never interprets it. So remote drift is followable now.
      const drifted = useAgentStore.getState().sessions.find((s) => s.id === tid)
      if (drifted?.worktreePath === event.worktreePath) break
      // Muted with "Not in this chat", or the "off" notice closed, maybe on
      // another client: say nothing, and take down what this window still shows.
      const follow = event.followSuggestions ?? 'auto'
      const dismissedHere = drifted?.followNoticeDismissed ?? false
      const view = followSuggestionView(follow, event.workedWorktrees ?? 0, (event.followNoticeDismissed ?? false) || dismissedHere)
      if (view.kind === 'chip' && dismissedHere) useAgentStore.getState().setFollowNoticeDismissed(tid, false)
      if (follow === 'muted' || view.kind === 'hidden') {
        useAgentStore.getState().setDriftSuggestion(tid, null)
        break
      }
      useAgentStore.getState().setDriftSuggestion(tid, {
        worktreePath: event.worktreePath,
        branch: event.branch,
        followSuggestions: follow,
        workedWorktrees: event.workedWorktrees ?? 0,
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
}
