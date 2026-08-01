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
