/**
 * Live, in-memory-only preview line for a session's Recents row and kanban
 * card tile: the agent's own `<agent_digest>` status line when it reported
 * one, else a raw truncated preview of the latest assistant text (today's
 * behavior). Derived from `AgentSession.messages`, which already lives in
 * the renderer's zustand store - no DB migration and no persistence, so
 * this resets on reload (until the next assistant message repopulates it).
 */
import type { ChatMessage } from '@shared/types'
import { extractDigest, stripDigest } from '@shared/agent-digest'

const RAW_PREVIEW_MAX_LENGTH = 70

export function sessionPreviewLine(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || !message.content) continue
    const digest = extractDigest(message.content)
    if (digest) return digest
    const raw = stripDigest(message.content).trim()
    if (!raw) continue
    return raw.length > RAW_PREVIEW_MAX_LENGTH
      ? `${raw.slice(0, RAW_PREVIEW_MAX_LENGTH - 1)}…`
      : raw
  }
  return undefined
}
