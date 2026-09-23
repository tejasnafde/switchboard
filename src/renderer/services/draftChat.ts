/**
 * Draft chat hand-off. A draft has no conversation row, so its first send
 * cannot go through the ordinary path. The draft pane parks the message under
 * the conversation id it pre-mints and asks the app to create that
 * conversation. The pane that shows the new session sends it once, through
 * its own send path.
 */
import type { ChatSendResult } from '../components/chat/ChatInput'

export interface FirstSend {
  message: string
  images?: Array<{ file: File; previewUrl: string }>
  extras?: {
    origin?: string
    displayBody?: string
    pillsMeta?: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }>
  }
}

export interface ParkedFirstSend extends FirstSend {
  draftId: string
}

const parked = new Map<string, ParkedFirstSend>()

/** Parked under the conversation id the draft pre-minted, never under a
 *  path: the backend may canonicalise the project path it echoes back. */
export function parkFirstSend(conversationId: string, send: ParkedFirstSend): void {
  parked.set(conversationId, send)
}

export function peekFirstSend(conversationId: string): ParkedFirstSend | undefined {
  return parked.get(conversationId)
}

/** Returns the parked send once; later calls for the same id get nothing. */
export function takeFirstSend(conversationId: string): ParkedFirstSend | undefined {
  const entry = parked.get(conversationId)
  parked.delete(conversationId)
  return entry
}

type Materializer = (draftId: string, send: FirstSend) => Promise<ChatSendResult>
let materializer: Materializer | null = null

export function setDraftMaterializer(fn: Materializer | null): void {
  materializer = fn
}

export function materializeDraft(draftId: string, send: FirstSend): Promise<ChatSendResult> {
  if (!materializer) return Promise.resolve({ accepted: false, error: 'New chats are not ready yet.' })
  return materializer(draftId, send)
}
