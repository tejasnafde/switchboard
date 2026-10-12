/**
 * Where a chat-message chip opens: the chat and the message it was quoted
 * from. A chip made by Cmd+L names both; an older chip only has its quote,
 * so it is found by text in the chat it sits in. Pure apart from `deps`, so
 * the rules are testable without a renderer.
 */
import type { PillChipTarget } from './pill-chip-model'

type MessageTarget = Extract<PillChipTarget, { type: 'message' }>

interface LoadedMessage {
  id: string
  role: string
  content: string
  displayBody?: string
}

export type PillMessageResolution =
  | { status: 'found'; sessionId: string; messageId: string }
  | { status: 'message-missing' }
  | { status: 'chat-missing' }
  /** Another open, or a manual navigation, replaced this one while it loaded. */
  | { status: 'superseded' }

export interface PillMessageDeps {
  /** The chat now focused, read fresh (it can change while history loads). */
  focusedId: () => string | null
  /** The chat's loaded rows, or undefined when it is not open. */
  sessionMessages: (sessionId: string) => readonly LoadedMessage[] | undefined
  /** Open a chat the way a sidebar click does; resolves to the focused chat after, or null when the chat is gone. */
  openChat: (conversationId: string) => Promise<string | null>
  /** The full-history path cmd+F uses. */
  ensureFullHistory: (sessionId: string) => Promise<boolean>
  /** False once a newer chip open has started. */
  isCurrent: () => boolean
}

/** The newest loaded message of `role` whose text holds `quote`. */
export function messageIdByQuote(
  messages: readonly LoadedMessage[] | undefined,
  role: MessageTarget['role'],
  quote: string,
): string | null {
  if (!messages || !quote) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== role) continue
    const text = role === 'user' ? `${message.displayBody ?? ''}\n${message.content}` : message.content
    if (text.includes(quote)) return message.id
  }
  return null
}

/**
 * Resolve a message chip to a loaded message. `hostSessionId` is the chat the
 * chip sits in. A source chat that is neither the host nor focused is opened
 * first. A message older than the loaded window is loaded with the rest of
 * the history. An id that is not found falls back to the quote, since a
 * reloaded history can carry different ids for the same message.
 */
export async function resolvePillMessage(
  target: MessageTarget,
  hostSessionId: string | null,
  deps: PillMessageDeps,
): Promise<PillMessageResolution> {
  const sessionId = target.source?.conversationId ?? hostSessionId
  if (!sessionId) return { status: 'message-missing' }

  if (sessionId !== hostSessionId && sessionId !== deps.focusedId()) {
    const opened = await deps.openChat(sessionId)
    if (!deps.isCurrent()) return { status: 'superseded' }
    if (opened === null) return { status: 'chat-missing' }
    if (opened !== sessionId) return { status: 'superseded' }
  }

  const find = (): string | null => {
    const messages = deps.sessionMessages(sessionId)
    const id = target.source?.messageId
    if (id && messages?.some((m) => m.id === id)) return id
    return messageIdByQuote(messages, target.role, target.quote)
  }

  let messageId = find()
  if (!messageId) {
    await deps.ensureFullHistory(sessionId)
    // A manual navigation away while history loaded leaves the jump undone,
    // rather than a pending scroll that fires when the chat is next opened.
    if (!deps.isCurrent() || (sessionId !== hostSessionId && deps.focusedId() !== sessionId)) {
      return { status: 'superseded' }
    }
    messageId = find()
  }
  return messageId ? { status: 'found', sessionId, messageId } : { status: 'message-missing' }
}
