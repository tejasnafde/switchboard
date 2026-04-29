/**
 * Helper invoked when a `turn.completed` event fires. Attaches the wall-clock
 * `durationMs` to the LAST assistant message in the session so MessageBubble
 * can render "Worked for X.Xs" Cursor-style.
 *
 * Pure & immutable — returns a new array (with a new last-assistant message
 * object) when a stamp happens, or the same reference otherwise so React
 * memoization doesn't break.
 */
import type { ChatMessage } from '@shared/types'

export function stampTurnDuration(
  messages: ChatMessage[],
  durationMs: number | undefined,
): ChatMessage[] {
  if (durationMs === undefined) return messages

  // Walk backwards to find the last assistant message
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      idx = i
      break
    }
  }
  if (idx === -1) return messages

  const next = messages.slice()
  next[idx] = { ...messages[idx], turnDurationMs: durationMs }
  return next
}
