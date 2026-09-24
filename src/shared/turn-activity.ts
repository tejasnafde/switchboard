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

/** A tool's input as rendered: adapters send an object or a preformatted string. */
export function toolInputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
}


/** What a stored tool row keeps of the output. The live row shows it all. */
export const STORED_TOOL_OUTPUT_MAX_CHARS = 32 * 1024

/** Head and tail of an output too long to store, with the cut marked. */
export function storedToolOutput(output: string): string {
  if (output.length <= STORED_TOOL_OUTPUT_MAX_CHARS) return output
  const half = STORED_TOOL_OUTPUT_MAX_CHARS / 2
  const omitted = output.length - STORED_TOOL_OUTPUT_MAX_CHARS
  return `${output.slice(0, half)}\n[${omitted} chars not stored]\n${output.slice(-half)}`
}
