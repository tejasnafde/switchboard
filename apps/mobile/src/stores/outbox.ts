/**
 * The send queue. Every message the user commits to goes through here.
 *
 * Not a fallback for the offline case: the ONLY send path. That is deliberate.
 * A queue used only when a send is known to have failed still loses the
 * ambiguous cases, which are the common ones on a phone - a socket that looks
 * open but is not, a reconnect in flight, a turn still running. Routing
 * everything through one path means those cases are ordinary rather than
 * exceptional, and the code that handles them is exercised on every send
 * instead of only when something has already gone wrong.
 *
 * The queue publishes optimistically and writes durably behind that, so the
 * composer clears on the tap frame rather than after disk IO. A failed write
 * rolls the message back out and the caller restores the draft.
 */
import { create } from 'zustand'
import { createLogger } from '@shared/logger'
import type { RuntimeMode } from '@shared/provider-events'
import { deliveryAction, retryDelayMs, shouldRetry, type QueuedMessage } from '../lib/outboxModel'
import { loadQueued, removeQueued, saveQueued } from '../lib/outboxStorage'
import { getClient } from './connections'
import { useChatStore, threadKey } from './chat'

const log = createLogger('store:outbox')

interface OutboxState {
  messages: QueuedMessage[]
  /** Message the user has reopened in the composer; held back from delivery. */
  editingId: string | null
  setEditing: (messageId: string | null) => void
}

export const useOutboxStore = create<OutboxState>((set) => ({
  messages: [],
  editingId: null,
  setEditing: (messageId) => set({ editingId: messageId }),
}))

/** Earliest time each message may be retried, by id. Runtime only: a restart
 *  legitimately starts from zero, since the reason for the delay is gone. */
const retryNotBefore = new Map<string, number>()

/** Messages the user is still waiting on for a given thread, oldest first. */
export function queuedFor(connectionId: string, threadId: string): QueuedMessage[] {
  return useOutboxStore
    .getState()
    .messages.filter((m) => m.connectionId === connectionId && m.threadId === threadId)
}

/**
 * Add a message. Resolves once it is durable.
 *
 * The store is updated synchronously so the composer can clear immediately;
 * the returned promise rejects if the durable write failed, and the message is
 * rolled back out so the caller can restore what the user typed.
 */
export async function enqueue(message: QueuedMessage): Promise<void> {
  useOutboxStore.setState((s) => ({ messages: [...s.messages, message] }))
  try {
    await saveQueued(message)
  } catch (err) {
    useOutboxStore.setState((s) => ({ messages: s.messages.filter((m) => m !== message) }))
    throw err
  }
  void drain()
}

async function forget(messageId: string): Promise<void> {
  retryNotBefore.delete(messageId)
  useOutboxStore.setState((s) => ({ messages: s.messages.filter((m) => m.messageId !== messageId) }))
  await removeQueued(messageId)
}

/** Restore anything left over from a previous run. */
export async function hydrateOutbox(): Promise<void> {
  const messages = await loadQueued()
  if (messages.length === 0) return
  log.info(`restored ${messages.length} unsent message(s)`)
  useOutboxStore.setState({ messages })
  void drain()
}

let draining = false

/**
 * Deliver what can be delivered, one message at a time per thread.
 *
 * Serial per thread on purpose: messages are ordered, and firing the second
 * while the first is in flight would let them land out of order.
 */
export async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (const message of nextPerThread()) {
      await deliver(message)
    }
  } finally {
    draining = false
  }
}

/** The head of each thread's queue, since only that one is eligible. */
function nextPerThread(): QueuedMessage[] {
  const heads = new Map<string, QueuedMessage>()
  for (const m of useOutboxStore.getState().messages) {
    const key = threadKey(m.connectionId, m.threadId)
    if (!heads.has(key)) heads.set(key, m)
  }
  return [...heads.values()]
}

async function deliver(message: QueuedMessage): Promise<void> {
  const client = getClient(message.connectionId)
  const chat = useChatStore.getState()
  const thread = chat.threads[threadKey(message.connectionId, message.threadId)]
  const action = deliveryAction({
    connected: client?.transport.isAlive?.() !== false && client !== undefined,
    // Only OpenCode drops a mid-turn message. Claude queues it in its adapter
    // and Codex steers it into the running turn, so holding those back would
    // add a delay for no reason.
    threadBusy: thread?.provider === 'opencode' && thread.status === 'running',
    threadExists: true,
    editing: useOutboxStore.getState().editingId === message.messageId,
    nowMs: Date.now(),
    retryNotBeforeMs: retryNotBefore.get(message.messageId) ?? 0,
  })
  if (action === 'wait') return
  if (action === 'drop' || !client) {
    if (action === 'drop') await forget(message.messageId)
    return
  }

  try {
    await client.sendTurn(
      message.threadId,
      message.text,
      message.runtimeMode as RuntimeMode | undefined,
      message.images,
      // Doubles as the idempotency key: the backend refuses an origin it has
      // already accepted, so a retry after an ambiguous failure is safe.
      message.messageId,
    )
    await forget(message.messageId)
  } catch (err) {
    if (!shouldRetry(err)) {
      // The backend understood and refused. Repeating it cannot help, and the
      // user needs to see why rather than watch it silently spin.
      log.warn('backend refused a queued message, dropping it', err)
      chat.ingest(message.connectionId, {
        type: 'error',
        threadId: message.threadId,
        message: `Message not sent: ${err instanceof Error ? err.message : String(err)}`,
      })
      await forget(message.messageId)
      return
    }
    const attempts = message.attempts + 1
    retryNotBefore.set(message.messageId, Date.now() + retryDelayMs(attempts))
    const updated = { ...message, attempts }
    useOutboxStore.setState((s) => ({
      messages: s.messages.map((m) => (m.messageId === message.messageId ? updated : m)),
    }))
    await saveQueued(updated).catch((e: unknown) => log.warn('could not persist a retry count', e))
  }
}
