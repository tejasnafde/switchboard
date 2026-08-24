import {
  canonicalizeForkMessage,
  type DirtySourceConfirmation,
  type DirtySourceReceipt,
  type ForkConversationRequest,
  type ForkConversationResult,
  type ForkError,
  type ForkRecoveryReceipt,
} from '../../shared/conversation-fork'
import type { ChatMessage } from '../../shared/types'
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'

interface DurableForkIntent {
  requestId: string
  sourceConversationId: string
  messageId: string
  checkoutKind: ForkConversationRequest['checkout']['kind']
  requestedAt: number
}

const pendingForks = new Map<string, DurableForkIntent>()
const FORK_STORAGE_KEY = 'switchboard.conversation-forks.desktop.v2'

export function durableForkKey(
  sourceConversationId: string,
  messageId: string,
  checkoutKind: ForkConversationRequest['checkout']['kind'],
): string {
  return `${sourceConversationId}\u0000${messageId}\u0000${checkoutKind}`
}

function loadForks(): void {
  if (pendingForks.size > 0) return
  try {
    const stored = JSON.parse(window.localStorage?.getItem(FORK_STORAGE_KEY) ?? '[]') as DurableForkIntent[]
    for (const intent of stored) {
      if (!intent?.requestId || !intent.sourceConversationId || !intent.messageId) continue
      pendingForks.set(
        durableForkKey(intent.sourceConversationId, intent.messageId, intent.checkoutKind),
        intent,
      )
    }
  } catch { /* backend idempotency remains authoritative */ }
}

function saveForks(): void {
  try {
    window.localStorage?.setItem(FORK_STORAGE_KEY, JSON.stringify([...pendingForks.values()]))
  } catch { /* retries in this renderer still retain the in-memory request id */ }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function projectForkSession(result: ForkConversationResult) {
  const conversation = result.conversation
  return {
    id: conversation.id,
    type: conversation.agentType,
    status: 'idle' as const,
    projectPath: conversation.projectPath,
    worktreePath: conversation.worktreePath,
    worktreeBranch: conversation.worktreeBranch,
    worktreeId: conversation.worktreeId,
    machineId: conversation.machineId,
    resumeSessionId: result.nativeResume?.sessionId,
    title: conversation.title,
    runtimeMode: conversation.runtimeMode,
    model: conversation.model ?? undefined,
    reasoningEffort: conversation.reasoningEffort ?? undefined,
    instanceId: conversation.providerInstanceId ?? undefined,
    forkMetadata: {
      ...(conversation.machineId ? { machineId: conversation.machineId } : {}),
      parentConversationId: conversation.parentConversationId,
      parentTitle: conversation.parentTitle,
      anchor: conversation.anchor,
      resumeMode: conversation.resumeMode,
      git: result.git,
      warnings: result.warnings,
    },
  }
}

export type ForkAndOpenResult =
  | { ok: true; result: ForkConversationResult }
  | {
      ok: false
      error: ForkError
      recovery?: ForkRecoveryReceipt
      dirtySource?: DirtySourceReceipt
    }

export async function forkAndOpenSession(
  sourceConversationId: string,
  message: ChatMessage,
  withWorktree = false,
  dirtySourceConfirmed?: DirtySourceConfirmation,
): Promise<ForkAndOpenResult> {
  const store = useAgentStore.getState()
  const source = store.sessions.find((session) => session.id === sourceConversationId)
  if (!source) {
    return {
      ok: false,
      error: { code: 'source-not-found', message: 'Source conversation is not loaded.', retryable: false },
    }
  }
  const checkoutKind = withWorktree ? 'new-worktree' : 'shared-checkout'
  const key = durableForkKey(sourceConversationId, message.id, checkoutKind)
  loadForks()
  const intent = pendingForks.get(key) ?? {
    requestId: crypto.randomUUID(),
    sourceConversationId,
    messageId: message.id,
    checkoutKind,
    requestedAt: Date.now(),
  }
  pendingForks.set(key, intent)
  saveForks()

  const request: ForkConversationRequest = {
    schemaVersion: 1,
    requestId: intent.requestId,
    sourceConversationId,
    ...(source.machineId ? { machineId: source.machineId } : {}),
    anchor: {
      messageId: message.id,
      role: message.role,
      timestamp: message.timestamp,
      contentDigest: await sha256(canonicalizeForkMessage(message)),
    },
    checkout: withWorktree
      ? {
          kind: 'new-worktree',
          basePolicy: 'source-head',
          ...(dirtySourceConfirmed ? { dirtySourceConfirmed } : {}),
        }
      : { kind: 'shared-checkout' },
    provenance: { surface: 'desktop', requestedAt: intent.requestedAt },
  }

  const prior = await window.api.app.getConversationFork({
    requestId: request.requestId,
    sourceConversationId,
    ...(source.machineId ? { machineId: source.machineId } : {}),
  })
  const outcome = prior?.kind === 'completed'
    ? prior
    : await window.api.app.forkConversation(request)
  if (outcome.kind === 'confirmation-required') {
    return {
      ok: false,
      error: {
        code: 'dirty-source-changed',
        message: outcome.dirtySource.omittedChangeSummary,
        retryable: true,
      },
      dirtySource: outcome.dirtySource,
    }
  }
  if (outcome.kind === 'failed') {
    return { ok: false, error: outcome.error, ...(outcome.recovery ? { recovery: outcome.recovery } : {}) }
  }

  const result = outcome.result
  const projected = projectForkSession(result)
  window.api.routing.bind(result.conversation.id, result.conversation.machineId ?? source.machineId ?? 'local')
  store.addSession(projected)
  store.setMessages(result.conversation.id, result.messages)
  store.setActiveSession(result.conversation.id)
  useLayoutStore.getState().setAppView('chats')
  pendingForks.delete(key)
  saveForks()
  return { ok: true, result }
}
