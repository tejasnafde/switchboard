/**
 * Fork-from-message orchestration on the renderer side.
 *
 * Calls the main-process IPC, then registers the new session in
 * `agent-store` with the cloned message list pre-loaded so the user
 * sees an exact copy the moment they land in the new tab. The agent's
 * resume primitive (Claude `--resume`, Codex sessionId) is wired via
 * `resumeSessionId` - the chat panel's existing startSession path picks
 * it up the first time the user sends a turn.
 */
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'
import type { WorktreeCreationSnapshot } from '../../shared/worktree-creation'

export function shouldClearForkWorktreeProgress(
  snapshot: Pick<WorktreeCreationSnapshot, 'status' | 'cleanupDisposition'>,
): boolean {
  return snapshot.cleanupDisposition === 'retained'
    || snapshot.cleanupDisposition === 'removed'
    || snapshot.status === 'cancelled'
}

interface DurableForkIntent {
  sourceConversationId: string
  upToIndex: number
  forkedAtMessageId?: string
  withWorktree: true
  creationId: string
  conversationId: string
  machineId: string
  requestedAt: number
}

const pendingForks = new Map<string, DurableForkIntent>()
const FORK_STORAGE_KEY = 'switchboard.worktree-forks.desktop.v1'

export function durableForkKey(sourceConversationId: string, upToIndex: number): string {
  return `${sourceConversationId}\u0000${upToIndex}`
}

function loadForks(): void {
  if (pendingForks.size > 0) return
  try {
    const stored = JSON.parse(window.localStorage?.getItem(FORK_STORAGE_KEY) ?? '[]') as DurableForkIntent[]
    for (const intent of stored) {
      if (intent?.withWorktree && intent.creationId && intent.conversationId) {
        pendingForks.set(durableForkKey(intent.sourceConversationId, intent.upToIndex), intent)
      }
    }
  } catch { /* a corrupt renderer cache must not block forking */ }
}

function saveForks(): void {
  try {
    window.localStorage?.setItem(FORK_STORAGE_KEY, JSON.stringify([...pendingForks.values()]))
  } catch { /* durable backend identity still protects a live renderer retry */ }
}

export function releaseForkWorktreeIntent(
  sourceConversationId: string,
  upToIndex: number,
  creationId: string,
): void {
  loadForks()
  const key = durableForkKey(sourceConversationId, upToIndex)
  if (pendingForks.get(key)?.creationId !== creationId) return
  pendingForks.delete(key)
  saveForks()
}

interface ForkSessionProjectionInput {
  conversation: {
    id: string
    projectPath: string
    agentType: string
    title: string
  }
  resumeHint: string | null
  worktree?: { path: string; branch: string }
}

export function projectForkSession(input: ForkSessionProjectionInput) {
  const type = input.conversation.agentType === 'codex'
    ? 'codex' as const
    : input.conversation.agentType === 'opencode'
      ? 'opencode' as const
      : 'claude-code' as const
  return {
    id: input.conversation.id,
    type,
    status: 'idle' as const,
    projectPath: input.conversation.projectPath,
    worktreePath: input.worktree?.path ?? null,
    worktreeBranch: input.worktree?.branch ?? null,
    resumeSessionId: input.resumeHint ?? undefined,
    title: input.conversation.title,
  }
}

export async function forkAndOpenSession(
  sourceConversationId: string,
  upToIndex: number,
  forkedAtMessageId?: string,
  /**
   * When true, the main side also creates a fresh git worktree off the
   * source repo's HEAD and roots the new conversation at it. The
   * `worktree` field on the returned object echoes the new branch name
   * so the caller can show a "Forked to fork/<slug>" toast.
   */
  withWorktree?: boolean,
  onWorktreeProgress?: (snapshot: WorktreeCreationSnapshot) => void,
): Promise<{
  ok: boolean
  error?: string
  newSessionId?: string
  resumable?: boolean
  worktree?: { path: string; branch: string }
  worktreeCreation?: WorktreeCreationSnapshot
}> {
  const store = useAgentStore.getState()
  const source = store.sessions.find((session) => session.id === sourceConversationId)
  const key = durableForkKey(sourceConversationId, upToIndex)
  loadForks()
  const durable = withWorktree
    ? pendingForks.get(key) ?? {
        sourceConversationId,
        upToIndex,
        ...(forkedAtMessageId ? { forkedAtMessageId } : {}),
        withWorktree: true as const,
        creationId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        machineId: source?.machineId ?? 'local',
        requestedAt: Date.now(),
      }
    : null
  if (durable) {
    pendingForks.set(key, durable)
    saveForks()
  }
  const creationId = durable?.creationId ?? crypto.randomUUID()
  const conversationId = durable?.conversationId ?? crypto.randomUUID()
  const machineId = durable?.machineId ?? source?.machineId ?? 'local'
  const unsubscribe = withWorktree && onWorktreeProgress
    ? window.api.worktreeCreation.onProgress((event) => {
        if (event.creationId !== creationId) return
        void window.api.worktreeCreation.get({ creationId, machineId })
          .then(onWorktreeProgress)
          .catch(() => {})
      })
    : () => {}
  const res = await window.api.app.forkConversation({
    sourceConversationId,
    upToIndex,
    forkedAtMessageId,
    withWorktree,
    creationId,
    conversationId,
    machineId,
    requestedAt: durable?.requestedAt ?? Date.now(),
  }).finally(unsubscribe)
  if (!res.ok) {
    if (res.worktreeCreation) onWorktreeProgress?.(res.worktreeCreation)
    return { ok: false, error: res.error, worktreeCreation: res.worktreeCreation }
  }

  const { conversation, resumeHint, messages, resumable, worktree } = res
  // Carry over the source session's runtime mode + model so the fork
  // doesn't silently drop into 'sandbox'/default-model just because it
  // landed in a fresh AgentSession entry. The agent backend resume picks
  // up where the parent left off; the UI controls should match.
  const projected = projectForkSession({ conversation, resumeHint, worktree })
  const type = projected.type
  window.api.routing.bind(conversation.id, machineId)
  store.addSession({
    ...projected,
    machineId,
    runtimeMode: source?.runtimeMode,
    model: source?.model,
  })
  // For non-resumable forks (Codex / OpenCode today), prepend a synthetic
  // system message so the user knows the new agent process starts cold -
  // without it the fork looks identical to a real resume. The main side
  // schedules a pending context handoff for these forks, so the first
  // send replays the copied transcript as a preamble (ChatPanel).
  const decorated = resumable
    ? messages
    : [
        {
          id: `system_fork_notice_${conversation.id}`,
          role: 'system' as const,
          // Strip both the plain `· fork` and the `· fork/<branch>` suffix
          // (added by #5 for worktree-backed forks) so the synthetic notice
          // names the *parent* conversation, not the fork itself.
          content: `Forked from "${conversation.title.replace(/ · fork(\/[^·]*)?$/, '')}" - ${type === 'codex' ? 'Codex' : type === 'opencode' ? 'OpenCode' : 'this agent'} starts a fresh process here; the earlier turns replay as context with your first message.`,
          timestamp: Date.now(),
        },
        ...messages,
      ]

  store.setMessages(conversation.id, decorated)
  store.setActiveSession(conversation.id)

  // Make sure we're on the chat view (in case the user was looking at
  // kanban). Mirrors what `openSessionByClick` does in App.tsx.
  useLayoutStore.getState().setAppView('chats')

  if (durable) {
    pendingForks.delete(key)
    saveForks()
  }

  return { ok: true, newSessionId: conversation.id, resumable, worktree }
}
