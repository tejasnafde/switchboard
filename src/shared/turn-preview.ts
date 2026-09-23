/**
 * Live preview line for a session/thread's CURRENT TURN - used by the
 * desktop sidebar Recents row, the kanban card tile, and the mobile
 * conversation list (see sessionPreview.ts / threadPreview.ts, the thin
 * per-surface adapters that map their own message shape onto
 * `PreviewMessage` and call `turnPreviewLine`).
 *
 * Claude splits one turn into several assistant messages at tool-call
 * boundaries, so the newest assistant message alone is not reliable: it is
 * often the message right after a tool call, with no digest of its own yet.
 * `turnPreviewLine` searches every assistant message in the current turn
 * (everything after the last user message) for a reported `<agent_digest>`
 * before falling back to a truncated raw preview of the newest one.
 */
import { extractDigest, stripDigest } from './agent-digest'

export interface PreviewMessage {
  text: string
  isAssistant: boolean
  isUser: boolean
}

const RAW_PREVIEW_MAX_LENGTH = 70

/**
 * Index of the first message in the current turn: right after the last
 * user message, or 0 (the whole array) when there is none.
 */
function currentTurnStart(messages: PreviewMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isUser) return i + 1
  }
  return 0
}

export function turnPreviewLine(messages: PreviewMessage[]): string | undefined {
  const turnStart = currentTurnStart(messages)

  // Digest first, searched newest-to-oldest across every assistant message
  // in the turn - an earlier message may carry the digest even when the
  // latest one (e.g. mid-tool-call) does not.
  for (let i = messages.length - 1; i >= turnStart; i--) {
    const message = messages[i]
    if (!message.isAssistant || !message.text) continue
    const digest = extractDigest(message.text)
    if (digest) return digest
  }

  // No digest anywhere in the turn - fall back to a truncated raw preview
  // of the newest non-empty assistant message (today's behavior). Uses
  // `streaming: true` unconditionally: a preview is already an approximate,
  // truncated stand-in for the real text, so hiding a still-forming tag at
  // its tail is the safer default here regardless of whether the message
  // has actually finished.
  for (let i = messages.length - 1; i >= turnStart; i--) {
    const message = messages[i]
    if (!message.isAssistant || !message.text) continue
    const raw = stripDigest(message.text, { streaming: true }).trim()
    if (!raw) continue
    return raw.length > RAW_PREVIEW_MAX_LENGTH
      ? `${raw.slice(0, RAW_PREVIEW_MAX_LENGTH - 1)}…`
      : raw
  }

  return undefined
}
