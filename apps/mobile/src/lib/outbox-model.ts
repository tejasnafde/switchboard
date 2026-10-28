/**
 * Rules for a queued message, as pure functions.
 *
 * Every send goes through the outbox - the primary path, not a fallback - so
 * these decide whether the user's message arrives, duplicates, or is lost.
 */

import { reconnectDelay } from '@shared/backoff'
import type { UserMessagePillsMeta } from '@shared/provider-events'
import { reviewPillTurn } from '@shared/pull-request-phone'
import { attachmentTurn, type SentAttachment } from '@shared/attachments'

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
  /** A mode the user picked on this phone, sent with the message. Absent
   *  otherwise, so the chat keeps the mode it has (set on the desktop, say). */
  runtimeMode?: string
  /** Marks `runtimeMode` as a pick. Older builds stored the thread's default
   *  mode on every message; that is dropped unless the message may have been
   *  sent, since the mode is part of the backend's fingerprint for it. */
  modePicked?: true
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
  /** Queued by the user for after the running turn, instead of steering it. */
  whenIdle?: boolean
  /** A review pill ("Work on PR", "Ask the agent") sent before the text (`reviewPillTurn`). */
  reviewPill?: QueuedReviewPill
  /** Files already saved on the backend, sent as path lines after the text (`attachmentTurn`). */
  attachments?: SentAttachment[]
}

export interface QueuedReviewPill {
  id: string
  label: string
  content: string
}

/**
 * What a queued message puts on the wire: a review pill first (`reviewPillTurn`),
 * then the text, then one line and one file chip per attachment (`attachmentTurn`).
 */
export function queuedTurnBody(message: Pick<QueuedMessage, 'text' | 'reviewPill' | 'attachments'>): {
  providerText: string
  displayBody: string
  pillsMeta?: UserMessagePillsMeta
} {
  const base: { providerText: string; displayBody: string; pillsMeta?: UserMessagePillsMeta } = message.reviewPill
    ? reviewPillTurn(message.text, message.reviewPill, message.reviewPill.id)
    : { providerText: message.text, displayBody: message.text }
  const files = message.attachments ?? []
  if (files.length === 0) return base
  const provider = attachmentTurn(base.providerText, files)
  return {
    providerText: provider.providerText,
    displayBody: attachmentTurn(base.displayBody, files).displayBody,
    pillsMeta: { ...base.pillsMeta, ...provider.pillsMeta },
  }
}

function parseAttachments(value: unknown): SentAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files = value.flatMap((item) => {
    const a = item as Partial<SentAttachment> | null
    return a &&
      typeof a.id === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(a.id) &&
      typeof a.name === 'string' &&
      typeof a.path === 'string' &&
      typeof a.label === 'string'
      ? [{ id: a.id, name: a.name, path: a.path, label: a.label }]
      : []
  })
  return files.length > 0 ? files : undefined
}

function parseReviewPill(value: unknown): QueuedReviewPill | undefined {
  const pill = value as Partial<QueuedReviewPill> | null | undefined
  return pill && typeof pill.id === 'string' && typeof pill.label === 'string' && typeof pill.content === 'string'
    ? { id: pill.id, label: pill.label, content: pill.content }
    : undefined
}

/** Frozen (persisted just before the first send), tried or unconfirmed: the backend may hold its fingerprint. */
function mayHaveBeenSent(message: Partial<QueuedMessage>): boolean {
  return (
    typeof message.providerText === 'string' || (message.attempts ?? 0) > 0 || message.deliveryState === 'ambiguous'
  )
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
      ? message.images.filter(
          (image): image is { url: string; mimeType?: string } =>
            Boolean(image) && typeof (image as { url?: unknown }).url === 'string',
        )
      : undefined,
    runtimeMode:
      typeof message.runtimeMode === 'string' && (message.modePicked === true || mayHaveBeenSent(message))
        ? message.runtimeMode
        : undefined,
    modePicked: message.modePicked === true ? true : undefined,
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
    attempts: typeof message.attempts === 'number' ? message.attempts : 0,
    blockedReason:
      typeof message.blockedReason === 'string' && message.blockedReason ? message.blockedReason : undefined,
    providerText: typeof message.providerText === 'string' ? message.providerText : undefined,
    pendingHandoff: typeof message.pendingHandoff === 'boolean' ? message.pendingHandoff : undefined,
    deliveryState: message.deliveryState === 'ambiguous' ? 'ambiguous' : undefined,
    titleCandidate: typeof message.titleCandidate === 'string' ? message.titleCandidate : undefined,
    whenIdle: message.whenIdle === true ? true : undefined,
    reviewPill: parseReviewPill(message.reviewPill),
    attachments: parseAttachments(message.attachments),
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

export function resolvedAmbiguousBubbleAction(status: 'abandoned' | 'completed'): 'remove' | 'keep' {
  return status === 'abandoned' ? 'remove' : 'keep'
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
    (message) => message.connectionId === connectionId && message.threadId === threadId && message.messageId === origin,
  )
  if (!accepted) return { accepted: undefined, remaining: messages }
  return { accepted, remaining: messages.filter((message) => message !== accepted) }
}

export function queuedBubbleExists(itemIds: string[], bubbleId: string): boolean {
  return itemIds.some((itemId) => itemId === bubbleId || itemId === `h-${bubbleId}`)
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

type DraftImage = { id: string; previewUri: string; url: string; mimeType: string }

function draftImages(message: QueuedMessage): DraftImage[] {
  return (message.images ?? []).map((image, index) => ({
    id: `recovered-${message.messageId}-${index}`,
    previewUri: image.url,
    url: image.url,
    mimeType: image.mimeType ?? 'image/png',
  }))
}

export function recoverRejectedDraft(
  message: QueuedMessage,
): { text: string; images: DraftImage[]; files: SentAttachment[] } | null {
  if (!message.blockedReason) return null
  return { text: message.text, images: draftImages(message), files: message.attachments ?? [] }
}

/** Messages held through a failed open or switch, put back after what the composer holds. */
export function returnedDraft(
  draft: string,
  messages: readonly QueuedMessage[],
): { text: string; images: DraftImage[]; files: SentAttachment[] } {
  return {
    text: [draft, ...messages.map((message) => message.text)].filter((part) => part.trim()).join('\n\n'),
    images: messages.flatMap(draftImages),
    files: messages.flatMap((message) => message.attachments ?? []),
  }
}

export function selectRejectedForEdit(messages: QueuedMessage[], messageId: string): QueuedMessage | null {
  return messages.find((message) => message.messageId === messageId && Boolean(message.blockedReason)) ?? null
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
  /** True while the chat opens or switches provider: it sends when that ends. */
  holding?: boolean
  nowMs: number
  /** When the next attempt is allowed, from the backoff. */
  retryNotBeforeMs: number
}): DeliveryAction {
  if (!input.threadExists) return 'drop'
  if (input.editing || input.holding) return 'wait'
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

export function deliveryFailureDisposition(providerAccepted: boolean, error: unknown): DeliveryFailureDisposition {
  if (providerAccepted) return 'cleanup-retry'
  return shouldRetry(error) ? 'retry' : 'reject'
}
