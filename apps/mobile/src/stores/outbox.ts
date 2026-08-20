/**
 * The send queue: the ONLY send path, not a fallback for the offline case.
 *
 * A queue used only on a KNOWN failure still loses the ambiguous cases, which
 * on a phone are the common ones - a socket that looks open but is not, a
 * reconnect in flight, a turn still running. One path makes those ordinary and
 * exercises the handling on every send.
 *
 * Publishes optimistically and writes durably behind that, so the composer
 * clears on the tap frame. A failed write rolls the message back out.
 */
import { create } from 'zustand'
import { createLogger } from '@shared/logger'
import type { RuntimeMode } from '@shared/provider-events'
import {
  deliveryAction,
  deliveryFailureDisposition,
  markRejected,
  nextDeliverablePerThread,
  retryDelayMs,
  type QueuedMessage,
} from '../lib/outboxModel'
import { loadQueued, removeQueued, saveQueued } from '../lib/outboxStorage'
import { getClient } from './connections'
import { useChatStore, threadKey } from './chat'
import { prepareMobileHandoffTurn } from '../lib/handoffTurn'

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

/** Earliest retry per message. Runtime only: a restart starts from zero. */
const retryNotBefore = new Map<string, number>()

/** Messages the user is still waiting on for a given thread, oldest first. */
export function queuedFor(connectionId: string, threadId: string): QueuedMessage[] {
  return useOutboxStore
    .getState()
    .messages.filter((m) => m.connectionId === connectionId && m.threadId === threadId)
}

/** Resolves once durable. The store updates synchronously so the composer can
 *  clear; a rejection means the message was rolled back out. */
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
let retryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Deliver everything deliverable, oldest first within each thread.
 *
 * Serial per thread: firing the second while the first is in flight lets them
 * land out of order. Loops until a pass makes no progress, so three messages
 * typed offline all go out when signal returns rather than one.
 */
export async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    // Tracks messages ATTEMPTED, not queue length: one enqueued mid-delivery
    // keeps the length flat, and a length check would never try it.
    const attempted = new Set<string>()
    for (;;) {
      const heads = nextPerThread().filter((m) => !attempted.has(m.messageId))
      if (heads.length === 0) break
      for (const message of heads) {
        attempted.add(message.messageId)
        await deliver(message)
      }
    }
  } finally {
    draining = false
    scheduleRetry()
  }
}

/** Without this, a retryable failure on a socket that STAYS up parks the
 *  message until a reconnect, a foreground, or the user opening that thread.
 *  Only arms for messages that actually failed; the drain loop covers the rest. */
function scheduleRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  const waits = [...retryNotBefore.values()]
  if (waits.length === 0) return
  const soonest = Math.min(...waits)
  const delay = Math.max(250, soonest - Date.now())
  retryTimer = setTimeout(() => {
    retryTimer = null
    void drain()
  }, delay)
  ;(retryTimer as { unref?: () => void }).unref?.()
}

/** The head of each thread's queue, since only that one is eligible. */
function nextPerThread(): QueuedMessage[] {
  return nextDeliverablePerThread(useOutboxStore.getState().messages)
}

async function deliver(message: QueuedMessage): Promise<void> {
  const client = getClient(message.connectionId)
  const chat = useChatStore.getState()
  const thread = chat.threads[threadKey(message.connectionId, message.threadId)]
  const action = deliveryAction({
    // `isConnected`, not `isAlive`: the latter stays true through a reconnect,
    // so a send with the radio off sat pending for the 200s provider timeout
    // and blocked the queue behind it.
    connected: client?.transport.isConnected?.() ?? client !== undefined,
    // Only OpenCode drops a mid-turn message; Claude queues and Codex steers.
    threadBusy: thread?.provider === 'opencode' && thread.status === 'running',
    // Always true today: the thread row is never removed by the app.
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

  let providerAccepted = false
  try {
    // A same-provider profile recovery can intentionally start a fresh native
    // session. Resolve its persisted handoff only when the queued turn is
    // actually deliverable; this survives offline sends and app restarts.
    const prepared = await prepareMobileHandoffTurn(client, message.threadId, message.text)
    await client.sendTurn(
      message.threadId,
      prepared.wireMessage,
      message.runtimeMode as RuntimeMode | undefined,
      message.images,
      // Doubles as the idempotency key, so a retry is safe.
      message.messageId,
    )
    providerAccepted = true
    if (prepared.pending) await client.setPendingHandoff(message.threadId, null)
    await forget(message.messageId)
  } catch (err) {
    const disposition = deliveryFailureDisposition(providerAccepted, err)
    if (disposition === 'reject') {
      // Understood and refused: repeating cannot help. Keep the committed
      // payload as a blocked record so text and attachments remain recoverable.
      const blocked = markRejected(message, err)
      retryNotBefore.delete(message.messageId)
      useOutboxStore.setState((state) => ({
        messages: state.messages.map((candidate) =>
          candidate.messageId === message.messageId ? blocked : candidate,
        ),
      }))
      await saveQueued(blocked).catch((storageError: unknown) =>
        log.warn('could not persist a rejected queued message', storageError),
      )
      log.warn('backend refused a queued message; preserving it for editing', err)
      chat.ingest(message.connectionId, {
        type: 'error',
        threadId: message.threadId,
        message: `Message not sent: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    if (disposition === 'cleanup-retry') {
      log.warn('provider accepted queued message; retrying handoff cleanup', err)
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
