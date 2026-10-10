/**
 * Builds a turn the backend echo can collapse onto. The chat store dedupes
 * `user.message` by id alone, so the optimistic bubble and the queued message
 * must agree on one origin - minting them apart renders the message twice.
 * Every send site builds here so that agreement holds in one place.
 */
import { echoMessageId } from '@shared/provider-events'
import type { QueuedMessage } from './outbox-model'

/** Random suffix, not the clock alone: two taps can land in one millisecond. */
export function ownTurn(): string {
  return `m${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface BuildTurnInput {
  connectionId: string
  threadId: string
  text: string
  images?: Array<{ url: string; mimeType?: string }>
  /** Only a mode the user picked on this phone; omit it to keep the chat's. */
  runtimeMode?: string
  titleCandidate?: string
  whenIdle?: boolean
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
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode, modePicked: true as const } : {}),
      titleCandidate: input.titleCandidate,
      ...(input.whenIdle ? { whenIdle: true } : {}),
      createdAt: Date.now(),
      attempts: 0,
    },
  }
}

/**
 * Durably queue a turn. A mode pick it carries is settled only once the write
 * succeeded: a failed write gives the text back, and the pick has to ride on
 * the retry too.
 */
export async function enqueueTurn(
  queued: QueuedMessage,
  enqueue: (message: QueuedMessage) => Promise<void>,
  settlePick: (mode: string) => void,
): Promise<void> {
  await enqueue(queued)
  if (queued.modePicked && queued.runtimeMode) settlePick(queued.runtimeMode)
}

/**
 * The mode to restore, and push, when a chat screen opens. Only a new chat
 * takes the phone's mode. An existing chat shows the one the backend reports
 * (history, then session.provider): pushing one remembered here would undo a
 * change made on the desktop since.
 */
export function modeToRestore<M extends string>(
  isNew: boolean | undefined,
  remembered: M | undefined,
  defaultMode: M | undefined,
): M | undefined {
  return isNew ? (remembered ?? defaultMode) : undefined
}
