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
 * A preview is one line of plain text, so markdown syntax would show as raw
 * backticks and asterisks. Keeps the words, drops the markup.
 * ponytail: regex pass, not a markdown parser; nested or unusual syntax may
 * leave a stray marker, which is harmless in a truncated one-liner.
 */
// A fence opens with 3+ backticks or tildes at the start of a line. It closes
// only at a line holding the same character, at least as many times, and
// nothing else; an unclosed fence (still streaming) runs to the end.
const FENCED_BLOCK = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm

export function plainPreviewText(text: string): string {
  return text
    .replace(FENCED_BLOCK, ' ')                  // fenced code blocks, closed or still streaming
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')    // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // links -> link text
    .replace(/`([^`]*)`/g, '$1')                 // inline code
    .replace(/(\*\*|__)(.+?)\1/g, '$2')           // bold
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2') // italic
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // headings, quotes, list markers
    .replace(/\s+/g, ' ')
    .trim()
}

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
    const plain = digest && plainPreviewText(digest)
    if (plain) return plain
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
    const raw = plainPreviewText(stripDigest(message.text, { streaming: true }))
    if (!raw) continue
    return raw.length > RAW_PREVIEW_MAX_LENGTH
      ? `${raw.slice(0, RAW_PREVIEW_MAX_LENGTH - 1)}…`
      : raw
  }

  return undefined
}
