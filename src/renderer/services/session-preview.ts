/**
 * Live, in-memory-only preview line for a session's Recents row and kanban
 * card tile: the agent's own `<agent_digest>` status line when it reported
 * one anywhere in the current turn, else a raw truncated preview of the
 * newest assistant text (today's behavior). Derived from
 * `AgentSession.messages`, which already lives in the renderer's zustand
 * store - no DB migration and no persistence, so this resets on reload
 * (until the next assistant message repopulates it).
 *
 * Thin adapter: maps `ChatMessage[]` onto the shared, surface-agnostic
 * `turnPreviewLine` (see `@shared/turn-preview` - also used by mobile's
 * `thread-preview.ts`), which does the actual turn-boundary and digest
 * search.
 */
import type { ChatMessage } from '@shared/types'
import { turnPreviewLine, type PreviewMessage } from '@shared/turn-preview'
import { isSyntheticOnlyUserText } from '@shared/synthetic-message'

export function sessionPreviewLine(messages: ChatMessage[]): string | undefined {
  return turnPreviewLine(
    messages.map(
      (message): PreviewMessage => ({
        text: message.content,
        isAssistant: message.role === 'assistant',
        // A background-task notification is not a turn boundary for the preview.
        isUser: message.role === 'user' && (message.displayBody !== undefined || !isSyntheticOnlyUserText(message.content)),
      }),
    ),
  )
}
