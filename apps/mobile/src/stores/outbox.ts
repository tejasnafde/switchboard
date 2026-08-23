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
  removeAcceptedOrigin,
  retryDelayMs,
  selectRejectedForEdit,
  type QueuedMessage,
} from '../lib/outboxModel'
import { loadQueued, removeQueued, saveQueued } from '../lib/outboxStorage'
import { getClient } from './connections'
import { useChatStore, threadKey } from './chat'
import { prepareMobileHandoffTurn } from '../lib/handoffTurn'
import { submitQueuedTurn } from '../lib/outboxDelivery'

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

async function finishAccepted(message: QueuedMessage): Promise<void> {
  const client = getClient(message.connectionId)
  if (!client) throw new Error('Backend not connected during acceptance cleanup')
  if (message.pendingHandoff) await client.setPendingHandoff(message.threadId, null)
  if (message.titleCandidate) await client.renameConversation(message.threadId, message.titleCandidate)
  await forget(message.messageId)
}

/** A canonical echo proves acceptance even if the RPC acknowledgement was lost. */
export async function acknowledgeAcceptedOrigin(
  connectionId: string,
  threadId: string,
  origin: string,
): Promise<boolean> {
  const reconciled = removeAcceptedOrigin(
    useOutboxStore.getState().messages,
    connectionId,
    threadId,
    origin,
  )
  if (!reconciled.accepted) return false
  await finishAccepted(reconciled.accepted)
  return true
}

export function openRejectedForEdit(messageId: string): QueuedMessage | null {
  const message = selectRejectedForEdit(useOutboxStore.getState().messages, messageId)
  if (!message) return null
  useOutboxStore.setState({ editingId: messageId })
  return message
}

export async function completeRejectedEdit(messageId: string): Promise<void> {
  await forget(messageId)
  useOutboxStore.setState((state) => ({
    editingId: state.editingId === messageId ? null : state.editingId,
  }))
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
    const delivered = await submitQueuedTurn(message, {
      prepare: (queued) => prepareMobileHandoffTurn(client, queued.threadId, queued.text),
      persist: async (prepared) => {
        useOutboxStore.setState((state) => ({
          messages: state.messages.map((candidate) =>
            candidate.messageId === prepared.messageId ? prepared : candidate,
          ),
        }))
        await saveQueued(prepared)
      },
      send: (prepared) => client.submitTurn({
        version: 1,
        threadId: prepared.threadId,
        origin: prepared.messageId,
        providerText: prepared.providerText ?? prepared.text,
        displayBody: prepared.text,
        images: prepared.images,
        runtimeMode: prepared.runtimeMode as RuntimeMode | undefined,
        autoTitleText: prepared.titleCandidate,
      }),
    })
    const prepared = delivered.message
    if (delivered.disposition === 'accepted') {
      providerAccepted = true
      await finishAccepted(prepared)
      return
    }
    if (
      (delivered.disposition === 'rejected' && !delivered.retryable) ||
      delivered.disposition === 'conflict'
    ) {
      await preserveRejected(prepared, delivered.reason ?? 'Backend refused the message', chat)
      return
    }
    await preserveForRetry(prepared, delivered.disposition === 'ambiguous')
  } catch (err) {
    const disposition = deliveryFailureDisposition(providerAccepted, err)
    if (disposition === 'reject') {
      const current = currentQueued(message) ?? message
      await preserveRejected(current, err instanceof Error ? err.message : String(err), chat)
      return
    }
    if (disposition === 'cleanup-retry') {
      log.warn('provider accepted queued message; retrying handoff cleanup', err)
    }
    await preserveForRetry(currentQueued(message) ?? message, true)
  }
}

function currentQueued(message: QueuedMessage): QueuedMessage | undefined {
  return useOutboxStore.getState().messages.find(
    (candidate) =>
      candidate.connectionId === message.connectionId &&
      candidate.threadId === message.threadId &&
      candidate.messageId === message.messageId,
  )
}

async function preserveForRetry(message: QueuedMessage, ambiguous: boolean): Promise<void> {
  const attempts = message.attempts + 1
  retryNotBefore.set(message.messageId, Date.now() + retryDelayMs(attempts))
  const updated: QueuedMessage = {
    ...message,
    attempts,
    deliveryState: ambiguous ? 'ambiguous' : undefined,
  }
  useOutboxStore.setState((state) => ({
    messages: state.messages.map((candidate) =>
      candidate.messageId === message.messageId ? updated : candidate,
    ),
  }))
  await saveQueued(updated).catch((error: unknown) => log.warn('could not persist a retry count', error))
}

async function preserveRejected(
  message: QueuedMessage,
  reason: string,
  chat: ReturnType<typeof useChatStore.getState>,
): Promise<void> {
  const blocked = markRejected(message, new Error(reason))
  retryNotBefore.delete(message.messageId)
  useOutboxStore.setState((state) => ({
    messages: state.messages.map((candidate) =>
      candidate.messageId === message.messageId ? blocked : candidate,
    ),
  }))
  await saveQueued(blocked).catch((storageError: unknown) =>
    log.warn('could not persist a rejected queued message', storageError),
  )
  log.warn('backend refused a queued message; preserving it for editing', reason)
  chat.ingest(message.connectionId, {
    type: 'error',
    threadId: message.threadId,
    message: `Message not sent: ${reason}`,
  })
}
