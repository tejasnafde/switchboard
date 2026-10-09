/**
 * Pure formatters for the multi-source context bridge.
 *
 * Each `format*Context` returns the exact text that gets appended to the
 * active draft via `useDraftStore.appendDraft`. Pure → trivially testable
 * → wire format stays locked down under refactor.
 *
 * The matching capture-and-append flow lives in `context-bridge.ts`; this
 * module only owns the string shaping.
 */
import { formatFilePathRef } from '@shared/file-path-ref'

export interface FileViewerCapture {
  path: string
  startLine: number
  endLine: number
  content: string
}

/**
 * File-viewer selection → `@<path>:<start>[-end>]` marker followed by a
 * fenced code block of the captured lines.
 *
 *   @src/main/index.ts:42-45
 *   ```
 *   const x = 1
 *   const y = 2
 *   ```
 */
export function formatFileViewerContext(cap: FileViewerCapture): string {
  const trimmed = cap.content.replace(/\s+$/g, '')
  const block = '```\n' + trimmed + '\n```\n'
  if (!cap.path) return block
  const marker = formatFilePathRef({
    path: cap.path,
    startLine: cap.startLine,
    endLine: cap.endLine,
  })
  return `@${marker}\n${block}`
}

export interface ChatMessageCapture {
  agent: string
  selection: string
}

/**
 * Chat-message selection → `> from <agent>: "<line1>"` followed by `> <lineN>`
 * for any continuation lines. The blockquote prefix tells the agent this is
 * an excerpt, not a fresh question.
 */
export function formatChatMessageContext(cap: ChatMessageCapture): string {
  const agent = cap.agent || 'agent'
  const text = cap.selection.trim()
  const lines = text.split('\n')
  const head = `> from ${agent}: "${lines[0] ?? ''}"`
  const tail = lines
    .slice(1)
    .map((l) => `> ${l}`)
    .join('\n')
  return tail ? `${head}\n${tail}\n` : `${head}\n`
}

/**
 * Who a ⌘L quote of a chat bubble names: the agent for its replies, "you" for
 * the user's own messages. Null for any other row (system notices), which
 * cannot be quoted.
 */
export function chatQuoteAuthor(role: string | null, agent: string): string | null {
  if (role === 'assistant') return agent
  if (role === 'user') return 'you'
  return null
}

/**
 * The one role a selection quotes, from every bubble it touches. A selection
 * that takes in both a user message and an agent reply has no single author,
 * so it is null and cannot be quoted.
 */
export function selectionQuoteRole(roles: ReadonlyArray<string | null>): string | null {
  // An end outside every bubble (the gap between rows) names no author.
  const distinct = [...new Set(roles.filter((role) => role !== null))]
  return distinct.length === 1 ? distinct[0] : null
}

/** Set on a chip in a sent bubble to its label, so a quote can read it. */
export const PILL_LABEL_ATTR = 'data-pill-label'

/**
 * The text of a selection in a user bubble, each chip as its label. The
 * browser's own selection text puts line breaks around the chips, which are
 * inline-flex boxes.
 */
export function textWithPillLabels(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof Element && node.hasAttribute(PILL_LABEL_ATTR)) return node.getAttribute(PILL_LABEL_ATTR) ?? ''
  let text = ''
  node.childNodes.forEach((child) => { text += textWithPillLabels(child) })
  return text
}
