/**
 * Rules for a queued message, as pure functions.
 *
 * Every send goes through the outbox - the primary path, not a fallback - so
 * these decide whether the user's message arrives, duplicates, or is lost.
 */

import { reconnectDelay } from '@shared/backoff'

/** A message the user has committed to sending, waiting for a live backend. */
export interface QueuedMessage {
  connectionId: string
  threadId: string
  /** Minted before the first attempt and reused on every retry, so the backend
   *  can tell a retry from a second message after an ambiguous failure. */
  messageId: string
  text: string
  /** Data URLs, already downscaled by the composer. */
  images?: Array<{ url: string; mimeType?: string }>
  /** The mode chosen at send time: a message queued in plan mode must not run
   *  in full access because the thread changed while it waited. */
  runtimeMode?: string
  createdAt: number
  /** Attempts made so far. Drives the backoff. */
  attempts: number
  /** A deterministic backend refusal. Retained so the original text and
   *  attachments remain recoverable instead of being deleted as delivered. */
  blockedReason?: string
  /** Exact provider-visible text frozen before the first delivery attempt. */
  providerText?: string
  /** Whether the frozen provider text contains a pending handoff preamble. */
  pendingHandoff?: boolean
  /** Unconfirmed delivery is retained without presenting the bubble as sent. */
  deliveryState?: 'ambiguous'
  /** Generated from the first visible turn, applied only after acceptance. */
  titleCandidate?: string
}

/** Shape check for records restored from an older or current app build. */
export function parseQueuedMessage(value: unknown): QueuedMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<QueuedMessage>
  if (
    typeof message.connectionId !== 'string' ||
    typeof message.threadId !== 'string' ||
    typeof message.messageId !== 'string' ||
    typeof message.text !== 'string'
  ) {
    return null
  }
  return {
    connectionId: message.connectionId,
    threadId: message.threadId,
    messageId: message.messageId,
    text: message.text,
    images: Array.isArray(message.images)
      ? message.images.filter((image): image is { url: string; mimeType?: string } =>
          Boolean(image) && typeof (image as { url?: unknown }).url === 'string',
        )
      : undefined,
    runtimeMode: typeof message.runtimeMode === 'string' ? message.runtimeMode : undefined,
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
    attempts: typeof message.attempts === 'number' ? message.attempts : 0,
    blockedReason: typeof message.blockedReason === 'string' && message.blockedReason
      ? message.blockedReason
      : undefined,
    providerText: typeof message.providerText === 'string' ? message.providerText : undefined,
    pendingHandoff: typeof message.pendingHandoff === 'boolean' ? message.pendingHandoff : undefined,
    deliveryState: message.deliveryState === 'ambiguous' ? 'ambiguous' : undefined,
    titleCandidate: typeof message.titleCandidate === 'string' ? message.titleCandidate : undefined,
  }
}

export type AcceptanceDisposition = 'accepted' | 'pending' | 'ambiguous' | 'rejected' | 'conflict'

export interface DecodedTurnAcceptance {
  disposition: AcceptanceDisposition
  retryable: boolean
  reason?: string
}

/** Old backends returned no body after accepting the positional call. */
export function decodeTurnAcceptance(result: unknown): DecodedTurnAcceptance {
  if (result === undefined) return { disposition: 'accepted', retryable: false }
  if (!result || typeof result !== 'object') return { disposition: 'ambiguous', retryable: true }
  const acceptance = result as {
    accepted?: unknown
    state?: unknown
    status?: unknown
    retryable?: unknown
    reason?: unknown
  }
  const reason = typeof acceptance.reason === 'string' ? acceptance.reason : undefined
  if (acceptance.status === 'rejected') {
    return { disposition: 'rejected', retryable: acceptance.retryable === true, reason }
  }
  if (acceptance.status === 'conflict') return { disposition: 'conflict', retryable: false, reason }
  if (acceptance.status === 'accepted') return { disposition: 'accepted', retryable: false, reason }
  if (acceptance.status === 'pending') return { disposition: 'pending', retryable: true, reason }
  if (acceptance.status === 'ambiguous') return { disposition: 'ambiguous', retryable: true, reason }
  if (acceptance.accepted === true && acceptance.state === 'completed') {
    return { disposition: 'accepted', retryable: false, reason }
  }
  if (acceptance.accepted === false && acceptance.state === 'pending') {
    return { disposition: 'pending', retryable: true, reason }
  }
  return { disposition: 'ambiguous', retryable: true, reason }
}

export function acceptanceDisposition(result: unknown): AcceptanceDisposition {
  return decodeTurnAcceptance(result).disposition
}

export function freezePreparedTurn(
  message: QueuedMessage,
  prepared: { pending: boolean; wireMessage: string },
): QueuedMessage {
  if (message.providerText !== undefined) return message
  return {
    ...message,
    providerText: prepared.wireMessage,
    pendingHandoff: prepared.pending,
  }
}

export function removeAcceptedOrigin(
  messages: QueuedMessage[],
  connectionId: string,
  threadId: string,
  origin: string,
): { accepted: QueuedMessage | undefined; remaining: QueuedMessage[] } {
  const accepted = messages.find(
    (message) =>
      message.connectionId === connectionId &&
      message.threadId === threadId &&
      message.messageId === origin,
  )
  if (!accepted) return { accepted: undefined, remaining: messages }
  return { accepted, remaining: messages.filter((message) => message !== accepted) }
}

export function outboxPresentation(message: QueuedMessage): {
  state: 'queued' | 'ambiguous' | 'failed'
  label: string
} {
  if (message.blockedReason) {
    return { state: 'failed', label: `Not sent - ${message.blockedReason}` }
  }
  if (message.deliveryState === 'ambiguous') {
    return { state: 'ambiguous', label: 'Delivery unconfirmed' }
  }
  return { state: 'queued', label: 'Waiting to send' }
}

export function recoverRejectedDraft(message: QueuedMessage): {
  text: string
  images: Array<{ id: string; previewUri: string; url: string; mimeType: string }>
} | null {
  if (!message.blockedReason) return null
  return {
    text: message.text,
    images: (message.images ?? []).map((image, index) => ({
      id: `recovered-${message.messageId}-${index}`,
      previewUri: image.url,
      url: image.url,
      mimeType: image.mimeType ?? 'image/png',
    })),
  }
}

export function selectRejectedForEdit(
  messages: QueuedMessage[],
  messageId: string,
): QueuedMessage | null {
  return messages.find(
    (message) => message.messageId === messageId && Boolean(message.blockedReason),
  ) ?? null
}

/** Preserve the committed turn while recording why automatic delivery stopped. */
export function markRejected(message: QueuedMessage, error: unknown): QueuedMessage {
  return {
    ...message,
    blockedReason: error instanceof Error ? error.message : String(error),
  }
}

/** Oldest deliverable message per thread; blocked records remain recoverable
 *  without holding later valid turns behind them. */
export function nextDeliverablePerThread(messages: QueuedMessage[]): QueuedMessage[] {
  const heads = new Map<string, QueuedMessage>()
  for (const message of messages) {
    if (message.blockedReason) continue
    const key = `${message.connectionId}\u0000${message.threadId}`
    if (!heads.has(key)) heads.set(key, message)
  }
  return [...heads.values()]
}

export const MAX_RETRY_DELAY_MS = 16_000

/** 1s doubling to a 16s cap. No jitter: one device's queue draining against one
 *  backend does not stampede, so spreading it only adds latency. */
export function retryDelayMs(attempts: number): number {
  return reconnectDelay(attempts, { baseMs: 1_000, capMs: MAX_RETRY_DELAY_MS })
}

export type DeliveryAction = 'send' | 'wait' | 'drop'

/**
 * What to do with the message at the head of a thread's queue.
 *
 * `threadBusy` is the caller's judgement, not a fact: Claude queues a mid-turn
 * message in its adapter and Codex steers it into the running turn. Only
 * OpenCode drops one.
 */
export function deliveryAction(input: {
  connected: boolean
  threadBusy: boolean
  /** False once the user has removed the thread, so the message has no home. */
  threadExists: boolean
  /** True while the user has this message open in the composer for editing. */
  editing: boolean
  nowMs: number
  /** When the next attempt is allowed, from the backoff. */
  retryNotBeforeMs: number
}): DeliveryAction {
  if (!input.threadExists) return 'drop'
  if (input.editing) return 'wait'
  if (!input.connected || input.threadBusy) return 'wait'
  if (input.nowMs < input.retryNotBeforeMs) return 'wait'
  return 'send'
}

/**
 * A transport failure says nothing about the message, so it retries. A refusal
 * means the backend understood and declined, and repeating it burns battery
 * against a wall. Retrying everything forever is the easier mistake to miss.
 */
export function shouldRetry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /closed|timed out|queue full|network|socket|ECONN|not connected/i.test(message)
}

export type DeliveryFailureDisposition = 'cleanup-retry' | 'retry' | 'reject'

export function deliveryFailureDisposition(
  providerAccepted: boolean,
  error: unknown,
): DeliveryFailureDisposition {
  if (providerAccepted) return 'cleanup-retry'
  return shouldRetry(error) ? 'retry' : 'reject'
}
