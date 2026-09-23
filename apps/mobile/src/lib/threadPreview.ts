/**
 * Live, in-memory-only preview line for a conversation-list row: the
 * agent's own <agent_digest> status line when it reported one, else a raw
 * truncated preview of the latest assistant text. Mirrors the desktop
 * sidebar's sessionPreview.ts.
 *
 * Only available once a thread has been opened this session - `items`
 * comes from the chat store's live FeedItem feed, which (like the
 * desktop's agent-store) is not fetched separately per row in the
 * conversation list. A never-opened row simply has no preview, which is
 * today's behavior for it (see docs/feature-parity/agent-digest.json).
 */
import type { FeedItem } from '../stores/chat'
import { extractDigest, stripDigest } from '@shared/agent-digest'

const RAW_PREVIEW_MAX_LENGTH = 70

export function threadPreviewLine(items: FeedItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'text' || item.stream !== 'assistant' || !item.text) continue
    const digest = extractDigest(item.text)
    if (digest) return digest
    const raw = stripDigest(item.text).trim()
    if (!raw) continue
    return raw.length > RAW_PREVIEW_MAX_LENGTH
      ? `${raw.slice(0, RAW_PREVIEW_MAX_LENGTH - 1)}…`
      : raw
  }
  return undefined
}
