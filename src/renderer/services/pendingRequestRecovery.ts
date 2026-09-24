/**
 * Recovers approval/question/plan cards a resume gap or a reload dropped.
 *
 * The backend keeps its own record of a thread's still-open cards
 * (`ProviderChannels.GET_PENDING_REQUESTS`, gated behind the
 * `pending_requests_v1` capability on a remote). This turns that record into
 * the exact `ChatMessage` shape ChatPanel's live `request.opened` /
 * `question.asked` / `plan.proposed` handlers build, so a recovered card
 * renders identically to one that arrived live.
 */
import type { PendingBlockingEvent } from '@shared/pending-requests'
import type { ChatMessage } from '@shared/types'
import { useAgentStore } from '../stores/agent-store'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:pending-recovery')
const MAX_RECOVERY_ATTEMPTS = 3

/** The message id a pending event renders under in the desktop transcript -
 *  matches the ids ChatPanel's live event handlers already build. */
export function pendingRequestMessageId(event: PendingBlockingEvent): string {
  switch (event.type) {
    case 'request.opened':
      return `approval_${event.requestId}`
    case 'question.asked':
      return `question_${event.requestId}`
    case 'plan.proposed':
      return `plan_${event.planId}`
  }
}

/** Pending events not already present among a thread's shown message ids. */
export function missingPendingCards(
  pending: readonly PendingBlockingEvent[],
  shownMessageIds: ReadonlySet<string>,
): PendingBlockingEvent[] {
  return pending.filter((event) => !shownMessageIds.has(pendingRequestMessageId(event)))
}

/** The same ChatMessage shape ChatPanel's live handlers append for each event type. */
export function pendingRequestToChatMessage(event: PendingBlockingEvent, timestamp: number): ChatMessage {
  const id = pendingRequestMessageId(event)
  switch (event.type) {
    case 'request.opened':
      return {
        id,
        role: 'assistant',
        content: '',
        timestamp,
        approval: { toolName: event.toolName, detail: event.detail, status: 'pending' },
      }
    case 'question.asked':
      return {
        id,
        role: 'assistant',
        content: '',
        timestamp,
        question: { requestId: event.requestId, questions: event.questions, status: 'pending' },
      }
    case 'plan.proposed':
      return {
        id,
        role: 'assistant',
        content: '',
        timestamp,
        plan: { id: event.planId, markdown: event.planMarkdown },
      }
  }
}

/**
 * Ask the backend what is still open for `threadId`, record it on the session
 * (the sidebar's "Needs you" reads that) and append whatever card this client
 * is missing. Safe to call on every thread open and reconnect:
 * `appendMessage` dedupes by id on its own, and this is a no-op when the
 * session has not been loaded into the store yet. `cards: false` records
 * without appending, for a chat nobody has opened: a message in an unopened
 * chat would stop its history from loading.
 *
 * A live event for the thread that lands while the backend is answering makes
 * that answer older than the store, so it is discarded and asked again.
 */
export async function recoverPendingRequests(threadId: string, { cards = true } = {}, attempt = 1): Promise<void> {
  if (attempt === 1) void recoverQueuedTurns(threadId)
  const getPendingRequests = window.api.provider?.getPendingRequests
  if (!getPendingRequests) return
  const revisionOf = () => useAgentStore.getState().sessions.find((s) => s.id === threadId)?.pendingRequestRevision ?? 0
  try {
    const revision = revisionOf()
    const pending = await getPendingRequests(threadId) ?? []
    const store = useAgentStore.getState()
    const session = store.sessions.find((s) => s.id === threadId)
    if (!session) return
    if (revisionOf() !== revision) {
      if (attempt < MAX_RECOVERY_ATTEMPTS) return recoverPendingRequests(threadId, { cards }, attempt + 1)
      log.warn(`pending request recovery for ${threadId} kept racing live events; keeping the live state`)
      return
    }
    if (pending.length || session.pendingRequests?.length) store.setPendingRequests(threadId, pending)
    if (!cards) return
    const shownIds = new Set(session.messages.map((m) => m.id))
    const missing = missingPendingCards(pending, shownIds)
    for (const event of missing) {
      store.appendMessage(threadId, pendingRequestToChatMessage(event, Date.now()))
    }
  } catch (err) {
    log.warn(`pending request recovery failed for ${threadId}`, err)
  }
}

/**
 * Ask the backend which of this thread's messages it still holds until the
 * running turn ends, so the queued rows survive a reload or a resume gap.
 * Every caller of `recoverPendingRequests` wants this too, so it runs from
 * there. An older backend has no such channel, which only means nothing is
 * listed.
 */
async function recoverQueuedTurns(threadId: string): Promise<void> {
  const listQueuedTurns = window.api.provider?.listQueuedTurns
  if (!listQueuedTurns) return
  try {
    const turns = await listQueuedTurns(threadId) ?? []
    const session = useAgentStore.getState().sessions.find((s) => s.id === threadId)
    if (!session || (turns.length === 0 && !session.queuedTurns)) return
    useAgentStore.getState().setQueuedTurns(threadId, turns)
  } catch (err) {
    log.warn(`queued turn recovery failed for ${threadId}`, err)
  }
}
