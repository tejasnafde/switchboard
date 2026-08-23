/**
 * Builds a turn the backend echo can collapse onto. The chat store dedupes
 * `user.message` by id alone, so the optimistic bubble and the queued message
 * must agree on one origin - minting them apart renders the message twice.
 * Every send site builds here so that agreement holds in one place.
 */
import { echoMessageId } from '@shared/provider-events'
import type { QueuedMessage } from './outboxModel'

/** Random suffix, not the clock alone: two taps can land in one millisecond. */
export function ownTurn(): string {
  return `m${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface BuildTurnInput {
  connectionId: string
  threadId: string
  text: string
  images?: Array<{ url: string; mimeType?: string }>
  runtimeMode?: string
  titleCandidate?: string
}

export interface BuiltTurn {
  /** For `addUserMessage`, and `removeUserMessage` if the write fails. */
  bubbleId: string
  /** Ready for `enqueue`. */
  queued: QueuedMessage
}

export function buildTurn(input: BuildTurnInput): BuiltTurn {
  const messageId = ownTurn()
  return {
    bubbleId: echoMessageId(messageId),
    queued: {
      connectionId: input.connectionId,
      threadId: input.threadId,
      messageId,
      text: input.text,
      // An empty list is not the same as none on the wire.
      images: input.images && input.images.length > 0 ? input.images : undefined,
      runtimeMode: input.runtimeMode,
      titleCandidate: input.titleCandidate,
      createdAt: Date.now(),
      attempts: 0,
    },
  }
}
