/**
 * The rules for a queued message, as pure functions.
 *
 * Sending used to be fire-and-forget: the composer cleared the draft, called
 * `sendTurn`, and if the socket was mid-reconnect the frame was dropped at the
 * queue bound or rejected at the 30s timeout. By then the text was gone from
 * the composer with no retry and no way to get it back. That is the worst
 * possible failure for the one action the app exists to perform.
 *
 * So every send goes through the outbox. It is the primary path, not a
 * fallback, which is why these rules get their own tested module rather than
 * living inline in a hook.
 */

import { reconnectDelay } from '@shared/backoff'

/** A message the user has committed to sending, waiting for a live backend. */
export interface QueuedMessage {
  connectionId: string
  threadId: string
  /**
   * Minted on the client before the first attempt and reused on every retry.
   *
   * This is what makes a retry safe after an ambiguous failure. A send that
   * timed out may well have been executed, and without a stable id the backend
   * cannot tell the retry from a second message.
   */
  messageId: string
  text: string
  /** Data URLs, already downscaled by the composer. */
  images?: Array<{ url: string; mimeType?: string }>
  /** The mode the user chose when they sent, not whatever is current when it
   *  finally goes out. A message queued in plan mode must not run in full
   *  access because the thread changed while it waited. */
  runtimeMode?: string
  createdAt: number
  /** Attempts made so far. Drives the backoff. */
  attempts: number
}

export const MAX_RETRY_DELAY_MS = 16_000

/**
 * 1s doubling to a 16s cap, on the shared ladder.
 *
 * No jitter: unlike a reconnect, these retries do not stampede. One device's
 * queue drains against one backend, so spreading them only adds latency.
 */
export function retryDelayMs(attempts: number): number {
  return reconnectDelay(attempts, { baseMs: 1_000, capMs: MAX_RETRY_DELAY_MS })
}

export type DeliveryAction = 'send' | 'wait' | 'drop'

/**
 * What to do with the message at the head of a thread's queue.
 *
 * `threadBusy` is the caller's judgement, not a fact about the thread. Claude
 * queues a mid-turn message in its own adapter and Codex steers it into the
 * running turn, so for those it is false even while a turn runs. Only OpenCode
 * silently drops one, which is why it had a bespoke in-memory queue in the
 * chat screen before this existed.
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
 * Whether a failed send is worth repeating.
 *
 * A transport failure says nothing about the message, so it retries. A refusal
 * says the backend understood and declined, and repeating it just burns the
 * battery against a wall until the user gives up. Retrying everything forever
 * is the more common mistake and the harder one to notice.
 */
export function shouldRetry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /closed|timed out|queue full|network|socket|ECONN|not connected/i.test(message)
}
