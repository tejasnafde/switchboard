/**
 * Pure formatters for the multi-source context bridge.
 *
 * Each `format*Context` returns the exact text that gets appended to the
 * active draft via `useDraftStore.appendDraft`. Pure → trivially testable
 * → wire format stays locked down under refactor.
 *
 * The matching capture-and-append flow lives in `contextBridge.ts`; this
 * module only owns the string shaping.
 */
import { formatFilePathRef } from '@shared/filePathRef'

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
