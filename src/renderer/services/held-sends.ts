/**
 * Messages sent while their chat is still opening or switching provider
 * instance. Each is accepted at once and shown as a queued row (a `local`
 * entry in the agent store's `queuedTurns`), then sent in order once the
 * wait ends. A wait that fails puts them back in the composer.
 *
 * Held here rather than in a pane, so a pane that closes during the wait
 * does not lose them: whichever pane shows the chat next sends them.
 */
import type { UserMessagePillsMeta } from '@shared/provider-events'
import { queuedTurnComposerText } from '@shared/queued-turns'
import type { MessageImage } from '@shared/types'
import { useChatWaitStore, type ChatWait } from '../stores/chat-wait-store'
import { useAgentStore } from '../stores/agent-store'
import { useDraftStore } from '../stores/draft-store'
import { focusComposer } from './composer-registry'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:held-sends')

export interface HeldSendExtras {
  origin?: string
  confirmedRecoveryOrigin?: string
  displayBody?: string
  pillsMeta?: UserMessagePillsMeta
}

export interface HeldSend {
  messageId: string
  message: string
  delivery?: string
  /** The row's own object URLs: the composer revokes its previews once the send is accepted. */
  images?: Array<{ file: File; previewUrl: string }>
  extras?: HeldSendExtras
}

export type HeldSendResult =
  | { accepted: true }
  | { accepted: false; error: string; delivery?: 'rejected' | 'ambiguous' }

export type HeldSendFn = (
  message: string,
  delivery?: string,
  images?: Array<{ file: File; previewUrl: string }>,
  extras?: HeldSendExtras,
) => Promise<HeldSendResult>

const held = new Map<string, HeldSend[]>()
let nextId = 0

/** A send must wait while its chat opens or while a switch or start is in flight. */
export function sendMustWait(opening: boolean, wait: ChatWait | undefined): boolean {
  return opening || wait?.pending === true
}

export function hasHeldSends(sessionId: string): boolean {
  return (held.get(sessionId)?.length ?? 0) > 0
}

/** Hold a send and show it as a queued row. Returns the row id. */
export function holdSend(sessionId: string, send: Omit<HeldSend, 'messageId'>): string {
  watchFailedWaits()
  const messageId = `held_${Date.now()}_${++nextId}`
  const images = send.images?.map((image) => ({ file: image.file, previewUrl: URL.createObjectURL(image.file) }))
  const entry: HeldSend = { ...send, messageId, ...(images ? { images } : {}) }
  held.set(sessionId, [...(held.get(sessionId) ?? []), entry])
  showRow(sessionId, entry)
  return messageId
}

function showRow(sessionId: string, send: HeldSend): void {
  const store = useAgentStore.getState()
  const rowImages: MessageImage[] | undefined = send.images?.map((image) => ({
    url: image.previewUrl,
    mimeType: image.file.type,
    name: image.file.name,
  }))
  store.appendMessage(sessionId, {
    id: send.messageId,
    role: 'user',
    content: send.message,
    displayBody: send.extras?.displayBody,
    pillsMeta: send.extras?.pillsMeta,
    images: rowImages,
    timestamp: Date.now(),
  })
  store.setLocalQueuedTurn(sessionId, send.messageId, {
    threadId: sessionId,
    messageId: send.messageId,
    text: send.message,
    queuedAt: Date.now(),
    local: true,
  })
}

function dropRow(sessionId: string, messageId: string): void {
  const store = useAgentStore.getState()
  store.setLocalQueuedTurn(sessionId, messageId, null)
  store.removeMessage(sessionId, messageId)
}

/** Remove every held send of the chat, rows and all. */
function takeHeldSends(sessionId: string): HeldSend[] {
  const sends = held.get(sessionId) ?? []
  held.delete(sessionId)
  for (const send of sends) dropRow(sessionId, send.messageId)
  return sends
}

function revokeImages(send: HeldSend): void {
  for (const image of send.images ?? []) URL.revokeObjectURL(image.previewUrl)
}

/** Put sends back in the composer: the text the agent would have read, and the images. */
function returnToComposer(sessionId: string, sends: readonly HeldSend[]): void {
  const drafts = useDraftStore.getState()
  for (const send of sends) {
    drafts.appendDraft(
      sessionId,
      queuedTurnComposerText(send.message, send.extras?.displayBody, send.extras?.pillsMeta),
    )
    if (send.images?.length) {
      drafts.addImages(
        sessionId,
        send.images.map((image, index) => ({ id: `${send.messageId}_${index}`, ...image })),
      )
    }
  }
  if (sends.length > 0) focusComposer(sessionId)
}

/**
 * A failed switch or open hands the sends back even when no pane shows the
 * chat: a later open clears the error, and the sends must not go out then.
 */
let watching = false
function watchFailedWaits(): void {
  if (watching) return
  watching = true
  useChatWaitStore.subscribe((state) => {
    for (const sessionId of [...held.keys()]) {
      if (state.waits[sessionId]?.error && !settling.has(sessionId)) {
        returnToComposer(sessionId, takeHeldSends(sessionId))
      }
    }
  })
}

/** Cancel one held send, as Cancel does for a queued turn. */
export function cancelHeldSend(sessionId: string, messageId: string): boolean {
  const sends = held.get(sessionId) ?? []
  const send = sends.find((candidate) => candidate.messageId === messageId)
  if (!send) return false
  const rest = sends.filter((candidate) => candidate !== send)
  if (rest.length > 0) held.set(sessionId, rest)
  else held.delete(sessionId)
  dropRow(sessionId, messageId)
  returnToComposer(sessionId, [send])
  return true
}

/** Cancel every held send of the chat (Stop, or a declined switch). */
export function cancelHeldSends(sessionId: string): boolean {
  const sends = takeHeldSends(sessionId)
  returnToComposer(sessionId, sends)
  return sends.length > 0
}

/** The open resolved to the chat's live root id: its held sends follow it there. */
export function moveHeldSends(fromSessionId: string, toSessionId: string): void {
  const sends = takeHeldSends(fromSessionId)
  if (sends.length === 0) return
  held.set(toSessionId, [...(held.get(toSessionId) ?? []), ...sends])
  for (const send of sends) showRow(toSessionId, send)
}

const settling = new Set<string>()

/**
 * Called whenever the chat's wait changes. While it still waits nothing
 * happens; a failed wait returns the sends to the composer (its error shows
 * in the wait banner); otherwise they go out one at a time, in order, each
 * with queue delivery so none steers into the turn before it. A message held
 * while they go out joins the end. A send the chat refuses goes back to the
 * composer with the ones after it.
 */
export async function settleHeldSends(
  sessionId: string,
  readState: () => { opening: boolean; wait: ChatWait | undefined },
  send: HeldSendFn,
  onRefused: (error: string, ambiguous: boolean) => void,
): Promise<void> {
  if (settling.has(sessionId)) return
  settling.add(sessionId)
  try {
    for (;;) {
      const state = readState()
      if (sendMustWait(state.opening, state.wait) || !hasHeldSends(sessionId)) return
      if (state.wait?.error) {
        returnToComposer(sessionId, takeHeldSends(sessionId))
        return
      }
      const [next, ...rest] = held.get(sessionId) ?? []
      if (rest.length > 0) held.set(sessionId, rest)
      else held.delete(sessionId)
      dropRow(sessionId, next.messageId)
      let result: HeldSendResult
      try {
        result = await send(next.message, 'queue', next.images, next.extras)
      } catch (err) {
        log.warn('held send threw', err)
        result = { accepted: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!result.accepted) {
        returnToComposer(sessionId, [next, ...takeHeldSends(sessionId)])
        onRefused(result.error, result.delivery === 'ambiguous')
        return
      }
      revokeImages(next)
    }
  } finally {
    settling.delete(sessionId)
  }
}

/** Test seam: forget every held send. */
export function resetHeldSendsForTests(): void {
  held.clear()
  settling.clear()
}
