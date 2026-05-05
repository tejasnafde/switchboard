import type { ChatMessage, ToolCall, MessageImage } from '@shared/types'

export type JsonlSource = 'claude-code' | 'codex'

/**
 * Parses JSONL session transcripts into normalized ChatMessages.
 *
 * Supports two wire formats:
 *
 * - **Claude Code** (default): `{ type: 'assistant' | 'user' | 'result',
 *   message: { content: [...] } }` — one object per line.
 *
 * - **Codex** (opt-in via `source: 'codex'`): `{ type: 'response_item',
 *   payload: { type: 'message', role: 'user'|'assistant'|'developer',
 *   content: [{ type: 'input_text'|'output_text', text: '...' }] } }`.
 *
 * Without the source param, Codex session files produced zero messages
 * because none of their event types matched — imported sessions appeared
 * empty in the sidebar. Pass `source: 'codex'` when loading a Codex file.
 */
export class JsonlParser {
  private buffer = ''
  private onMessage: (message: ChatMessage) => void
  private source: JsonlSource

  constructor(onMessage: (message: ChatMessage) => void, source: JsonlSource = 'claude-code') {
    this.onMessage = onMessage
    this.source = source
  }

  /** Feed raw string data (may contain partial lines) */
  feed(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')

    // Last element is either empty (line ended with \n) or a partial line
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.parseLine(trimmed)
    }
  }

  /** Flush any remaining buffered data */
  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim())
      this.buffer = ''
    }
  }

  private parseLine(line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      // Not valid JSON — skip (could be raw TUI output)
      return
    }

    const message = this.normalizeEvent(parsed)
    if (message) {
      this.onMessage(message)
    }
  }

  private normalizeEvent(event: Record<string, unknown>): ChatMessage | null {
    if (this.source === 'codex') {
      return normalizeCodexEvent(event)
    }
    const type = event.type as string | undefined

    // Prefer the JSONL line's own timestamp (Claude SDK writes ISO strings
    // at the event root) so re-parses preserve chronological order. Without
    // this every line gets stamped Date.now() at parse time and out-of-band
    // markers (e.g. the rotation pill) end up clumped before all turns.
    const rawTs = event.timestamp
    const parsedTs = typeof rawTs === 'string' ? Date.parse(rawTs)
      : typeof rawTs === 'number' ? rawTs
      : NaN
    const ts = Number.isFinite(parsedTs) ? parsedTs : Date.now()

    switch (type) {
      case 'assistant': {
        const content = extractContent(event.message)
        const toolCalls = extractToolCalls(event.message)
        // Skip assistant messages with no visible content (e.g., thinking-only)
        if (!content && toolCalls.length === 0) return null
        return {
          id: (event.id as string) ?? generateId(),
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: ts,
        }
      }

      case 'user': {
        const content = extractContent(event.message)
        const images = extractImages(event.message)
        // Skip user messages that only contain tool_result blocks (internal protocol)
        // — but keep messages that have images even without text content, so
        // historical image-only user messages reappear after reload.
        if (!content && images.length === 0 && hasOnlyToolResults(event.message)) return null
        return {
          id: (event.id as string) ?? generateId(),
          role: 'user',
          content,
          images: images.length > 0 ? images : undefined,
          timestamp: ts,
        }
      }

      case 'result': {
        return {
          id: generateId(),
          role: 'assistant',
          content: (event.result as string) ?? '',
          timestamp: ts,
        }
      }

      default:
        return null
    }
  }
}

function extractContent(message: unknown): string {
  if (!message || typeof message !== 'object') return ''

  const msg = message as Record<string, unknown>

  // Handle content array format: [{ type: "text", text: "..." }, ...]
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((block: Record<string, unknown>) => block.type === 'text')
      .map((block: Record<string, unknown>) => block.text)
      .join('\n')
  }

  if (typeof msg.content === 'string') return msg.content
  return ''
}

/**
 * Reconstruct `MessageImage[]` from Claude's image content blocks.
 *
 * Claude Code JSONL stores user-attached images as:
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 *
 * Without this extraction, images attached to a user message (from
 * Switchboard) would vanish on reload — only the text would come back.
 */
function extractImages(message: unknown): MessageImage[] {
  if (!message || typeof message !== 'object') return []
  const msg = message as Record<string, unknown>
  if (!Array.isArray(msg.content)) return []

  const images: MessageImage[] = []
  for (const block of msg.content as Array<Record<string, unknown>>) {
    if (block.type !== 'image') continue
    const source = block.source as Record<string, unknown> | undefined
    if (!source) continue
    if (source.type === 'base64' && typeof source.data === 'string') {
      const mimeType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
      images.push({
        url: `data:${mimeType};base64,${source.data}`,
        mimeType,
      })
    } else if (source.type === 'url' && typeof source.url === 'string') {
      images.push({ url: source.url })
    }
  }
  return images
}

/** Check if a user message only contains tool_result blocks (no real user text) */
function hasOnlyToolResults(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const msg = message as Record<string, unknown>
  if (!Array.isArray(msg.content)) return false
  return msg.content.length > 0 &&
    msg.content.every((block: Record<string, unknown>) =>
      block.type === 'tool_result' || block.type === 'image'
    )
}

function extractToolCalls(message: unknown): ToolCall[] {
  if (!message || typeof message !== 'object') return []

  const msg = message as Record<string, unknown>
  if (!Array.isArray(msg.content)) return []

  return msg.content
    .filter((block: Record<string, unknown>) => block.type === 'tool_use')
    .map((block: Record<string, unknown>) => ({
      id: (block.id as string) ?? generateId(),
      name: (block.name as string) ?? 'unknown',
      input: typeof block.input === 'string'
        ? block.input
        : JSON.stringify(block.input, null, 2),
    }))
}

let idCounter = 0
function generateId(): string {
  return `msg_${Date.now()}_${++idCounter}`
}

// ─── Codex event schema normalization ──────────────────────────

/**
 * Convert a Codex JSONL event to a ChatMessage, or null if the event should
 * be skipped (non-visible event types, system/developer prompts, etc).
 *
 * Codex schema (observed in ~/.codex/archived_sessions/*.jsonl):
 *   { timestamp, type: 'response_item', payload: {
 *       type: 'message',
 *       role: 'user' | 'assistant' | 'developer' | 'system',
 *       content: [{ type: 'input_text'|'output_text', text: '...' }]
 *   } }
 * Plus metadata events: session_meta, turn_context, event_msg — all skipped.
 *
 * Extracted as a pure function for unit testing.
 */
export function normalizeCodexEvent(event: Record<string, unknown>): ChatMessage | null {
  const type = event.type as string | undefined
  if (type !== 'response_item') return null

  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload || payload.type !== 'message') return null

  const role = payload.role as string | undefined
  // Skip `developer` and `system` — those are prompt-injected context
  // (permissions preamble, AGENTS.md, etc.), not real conversation turns.
  if (role !== 'user' && role !== 'assistant') return null

  const content = extractCodexText(payload.content)
  if (!content) return null

  // Codex timestamps are ISO strings at the event root.
  const ts = typeof event.timestamp === 'string'
    ? Date.parse(event.timestamp)
    : Date.now()

  return {
    id: generateId(),
    role: role as 'user' | 'assistant',
    content,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
  }
}

function extractCodexText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block: Record<string, unknown>) => {
      const blockType = block.type as string | undefined
      if (blockType === 'input_text' || blockType === 'output_text' || blockType === 'text') {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
