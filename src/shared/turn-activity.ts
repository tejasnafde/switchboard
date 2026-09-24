/**
 * Ids and shapes for a turn's tool and changed-file rows. The renderer builds
 * these rows live from `tool.started` / `file.edited`, and the backend mirrors
 * the same rows to SQLite at turn end, so both must agree on the ids: the
 * desktop persists a diff card's accept/reject by the live id.
 */
import type { ChatMessage } from './types'

/** Scoped by thread: `messages.id` is global, and a provider may reuse `call_0`. */
export const toolRowId = (threadId: string, toolId: string): string => `tool_${threadId}:${toolId}`

export const fileDiffRowId = (fileEditId: string): string => `filediff_${fileEditId}`

/** A tool or changed-file row: no text of its own. */
export function isActivityRow(message: ChatMessage): boolean {
  return !message.content && (!!message.toolCalls?.length || !!message.fileDiff)
}

/**
 * Where a history window of `limit` messages starts. Only messages with text
 * count, so a tool-heavy chat still shows as many turns, with their tool and
 * changed-file rows.
 */
export function historyTailStart(messages: ChatMessage[], limit: number): number {
  let start = messages.length
  for (let kept = 0; start > 0 && kept < limit; start--) {
    if (!isActivityRow(messages[start - 1])) kept++
  }
  return start
}

/**
 * Tool and changed-file text a windowed history load may carry in total.
 * The text window alone does not bound it: 250 turns of Edit calls and diff
 * cards can each be large.
 */
export const HISTORY_ACTIVITY_MAX_CHARS = 8 * 1024 * 1024

function activityChars(message: ChatMessage): number {
  let chars = 0
  for (const call of message.toolCalls ?? []) chars += call.input.length + (call.output?.length ?? 0)
  if (message.fileDiff) chars += message.fileDiff.oldContent.length + message.fileDiff.newContent.length
  return chars
}

/**
 * The last `limit` messages with text, with the tool and changed-file rows
 * among them while they fit in `activityBudget`. The newest are kept, so an
 * over-budget window loses its oldest activity rows and none of its text.
 */
export function historyTail(
  messages: ChatMessage[],
  limit: number,
  activityBudget = HISTORY_ACTIVITY_MAX_CHARS,
): ChatMessage[] {
  const tail = messages.slice(historyTailStart(messages, limit))
  const kept: ChatMessage[] = []
  let spent = 0
  for (let i = tail.length - 1; i >= 0; i--) {
    if (isActivityRow(tail[i])) {
      spent += activityChars(tail[i])
      if (spent > activityBudget) continue
    }
    kept.push(tail[i])
  }
  return kept.reverse()
}

/** A tool's input as rendered: adapters send an object or a preformatted string. */
export function toolInputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
}

/** What a stored tool row keeps of its input and of its output. The live row shows all of it. */
export const STORED_TOOL_TEXT_MAX_CHARS = 32 * 1024

/** Head and tail of a tool input or output too long to store, with the cut marked. */
export function storedToolText(text: string): string {
  if (text.length <= STORED_TOOL_TEXT_MAX_CHARS) return text
  const half = STORED_TOOL_TEXT_MAX_CHARS / 2
  const omitted = text.length - STORED_TOOL_TEXT_MAX_CHARS
  return `${text.slice(0, half)}\n[${omitted} chars not stored]\n${text.slice(-half)}`
}
