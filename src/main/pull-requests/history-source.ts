/**
 * Reads a chat's stored history for the PR history scan, one piece at a time,
 * and stops as soon as the reader has enough: the SQLite mirror row by row,
 * then each Claude and Codex transcript line by line through `JsonlParser`.
 * The sources are the ones `conversations/history.ts` opens a chat from, but
 * nothing here loads a whole transcript, so a huge chat costs no more than
 * the scan's character cap.
 *
 * The transcript parser keeps what a chat shows and drops tool results (and,
 * for Codex, tool calls), which is where a CLI such as bbpr prints its PR
 * URL, so those blocks are read from the same line here.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ChatMessage, ToolCall } from '@shared/types'
import {
  conversationSessionHints,
  iterateMessageTextForConversation,
  listConversationSegments,
  threadFamilyIds,
} from '../db/database'
import { JsonlParser, type JsonlSource } from '../agent/jsonl-parser'
import { claudeCandidateDirs, listClaudeSessionCopies, type SessionCopy } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:history-source')

export type HistoryPartKind = 'text' | 'toolInput' | 'toolOutput'

/** Receives each piece of history in order; returning false stops the read. */
export type HistoryVisitor = (kind: HistoryPartKind, text: string) => boolean

function visitMessage(message: ChatMessage, visit: HistoryVisitor): boolean {
  if (message.content && !visit('text', message.content)) return false
  for (const call of message.toolCalls ?? []) {
    if (call.input && !visit('toolInput', call.input)) return false
    if (call.output && !visit('toolOutput', call.output)) return false
  }
  return true
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n')
}

/** Tool inputs and outputs the transcript parser leaves out of a line. */
function droppedToolParts(event: Record<string, unknown>, source: JsonlSource): Array<[HistoryPartKind, string]> {
  const parts: Array<[HistoryPartKind, string]> = []
  if (source === 'claude-code') {
    const content = (event.message as { content?: unknown } | undefined)?.content
    if (event.type !== 'user' || !Array.isArray(content)) return parts
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_result') parts.push(['toolOutput', blockText(block.content)])
    }
    return parts
  }
  const payload = event.payload as Record<string, unknown> | undefined
  if (event.type !== 'response_item' || !payload) return parts
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const input = payload.arguments ?? payload.input
    if (typeof input === 'string') parts.push(['toolInput', input])
  } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = payload.output
    parts.push(['toolOutput', typeof output === 'string' ? output : blockText((output as { content?: unknown } | undefined)?.content)])
  }
  return parts
}

const MAY_HOLD_DROPPED_TOOL_PART = /"(?:tool_result|function_call|function_call_output|custom_tool_call|custom_tool_call_output)"/

/** Streams one transcript into `visit`. Returns false once `visit` asked to stop; throws on a read failure other than a missing file. */
export async function readJsonlHistory(filePath: string, source: JsonlSource, visit: HistoryVisitor): Promise<boolean> {
  const parsed: ChatMessage[] = []
  const parser = new JsonlParser((message) => parsed.push(message), source)
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      parser.feed(`${line}\n`)
      for (const message of parsed.splice(0)) {
        if (!visitMessage(message, visit)) return false
      }
      if (!MAY_HOLD_DROPPED_TOOL_PART.test(line)) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch (err) {
        log.debug('skipping a transcript line that is not JSON', { filePath, err: String(err) })
        continue
      }
      for (const [kind, text] of droppedToolParts(event, source)) {
        if (text && !visit(kind, text)) return false
      }
    }
    return true
  } catch (err) {
    // A copy that vanished since it was listed is skipped; any other failure
    // may have cut the read short, so the scan must not count as finished.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    log.warn('reading a transcript for the PR scan failed', { filePath, err: String(err) })
    throw err
  } finally {
    lines.close()
    stream.destroy()
  }
}

function parseToolCalls(json: string | null): ToolCall[] {
  if (!json) return []
  try {
    const calls: unknown = JSON.parse(json)
    return Array.isArray(calls) ? calls as ToolCall[] : []
  } catch (err) {
    log.debug('stored tool calls did not parse', { err: String(err) })
    return []
  }
}

/** The most complete copy of a Claude session across every profile directory. */
function largestClaudeCopy(sessionId: string): SessionCopy | null {
  let best: SessionCopy | null = null
  for (const dir of claudeCandidateDirs()) {
    const copy = listClaudeSessionCopies(dir, sessionId)[0]
    if (copy && (!best || copy.size > best.size)) best = copy
  }
  return best
}

/**
 * Feeds `visit` the chat's history: the SQLite mirror (which holds tool
 * output for chats run in Switchboard), then its Claude and Codex transcripts.
 * The same text can come from more than one source; `visit` dedupes.
 */
export async function readConversationHistory(conversationId: string, visit: HistoryVisitor): Promise<void> {
  const familyIds = threadFamilyIds(conversationId)
  for (const id of familyIds) {
    for (const row of iterateMessageTextForConversation(id)) {
      const message = { id: '', role: 'assistant', timestamp: 0, content: row.content, toolCalls: parseToolCalls(row.tool_calls) } as ChatMessage
      if (!visitMessage(message, visit)) return
    }
  }

  const hints = conversationSessionHints(conversationId)
  const segments = listConversationSegments(conversationId)
  const sessionIds = new Set([...familyIds, ...hints, ...segments.map((s) => s.provider_session_id)])
  const claudeIds = new Set([
    ...familyIds,
    ...hints,
    ...segments.filter((s) => s.provider === 'claude-code').map((s) => s.provider_session_id),
  ])
  for (const sessionId of claudeIds) {
    const copy = largestClaudeCopy(sessionId)
    if (copy && !(await readJsonlHistory(copy.path, 'claude-code', visit))) return
  }

  for (const session of await scanCodexSessionCopies(sessionIds, codexCandidateDirs())) {
    if (!sessionIds.has(session.id) || !session.filePath) continue
    if (!(await readJsonlHistory(session.filePath, 'codex', visit))) return
  }
}
