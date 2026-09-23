/**
 * Live, in-memory-only preview line for a conversation-list row: the
 * agent's own <agent_digest> status line when it reported one anywhere in
 * the current turn, else a raw truncated preview of the newest assistant
 * text. Mirrors the desktop sidebar's sessionPreview.ts.
 *
 * Only available once a thread has been opened this session - `items`
 * comes from the chat store's live FeedItem feed, which (like the
 * desktop's agent-store) is not fetched separately per row in the
 * conversation list. A never-opened row simply has no preview, which is
 * today's behavior for it (see docs/feature-parity/agent-digest.json).
 *
 * Thin adapter: maps `FeedItem[]` onto the shared, surface-agnostic
 * `turnPreviewLine` (see `@shared/turn-preview` - also used by desktop's
 * sessionPreview.ts), which does the actual turn-boundary and digest
 * search. Only `user` items and `text`/`assistant`-stream items carry a
 * turn-preview signal; tool calls, reasoning/plan streams and everything
 * else are skipped rather than mapped in, since they neither bound a turn
 * nor can carry the digest tag.
 */
import type { FeedItem } from '../stores/chat'
import { turnPreviewLine, type PreviewMessage } from '@shared/turn-preview'

export function threadPreviewLine(items: FeedItem[]): string | undefined {
  const messages: PreviewMessage[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      messages.push({ text: item.text, isAssistant: false, isUser: true })
    } else if (item.kind === 'text' && item.stream === 'assistant') {
      messages.push({ text: item.text, isAssistant: true, isUser: false })
    }
  }
  return turnPreviewLine(messages)
}
