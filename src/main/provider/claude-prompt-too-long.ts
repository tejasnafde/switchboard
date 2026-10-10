/**
 * A Claude turn whose prompt no longer fits the model's context window, seen
 * on the first turn after a profile switch to an account with a smaller
 * window. The CLI reports it as a synthetic assistant message ("Prompt is too
 * long") and an `is_error` result with `terminal_reason: 'prompt_too_long'`.
 * The adapter compacts the conversation and sends the turn again, once,
 * instead of showing the CLI's text as an error.
 */

const PROMPT_TOO_LONG = /\bprompt is too long\b/i

export const COMPACT_COMMAND = '/compact'

/** `/compact`, alone or with instructions; not `/compactor` or `/compact-notes`. */
const COMPACT_INVOCATION = /^\s*\/compact(?:\s|$)/i

export const COMPACTING_NOTICE =
  "(This conversation no longer fits the model's context window. Compacting it, then sending your message again.)"

export const PROMPT_TOO_LONG_MESSAGE =
  "This conversation no longer fits the model's context window, and compacting it did not help. " +
  'Start a new chat, or pick a model with a larger context window.'

/** Messages are queued behind the turn, and the CLI would start them before a `/compact` sent now. */
export const COMPACT_FIRST_MESSAGE =
  "This conversation no longer fits the model's context window. Send /compact, then send your message again."

/** Compacted, but a message queued meanwhile runs first, so the turn was not sent again. */
export const COMPACTED_NOT_RESENT_MESSAGE =
  'The conversation was compacted, but your message was not sent again because a queued message runs first. Send it again.'

export function isPromptTooLongText(text: string | undefined | null): boolean {
  return typeof text === 'string' && PROMPT_TOO_LONG.test(text)
}

export function isPromptTooLongResult(result: {
  is_error?: boolean
  terminal_reason?: string
  result?: unknown
  errors?: unknown
}): boolean {
  if (result.terminal_reason === 'prompt_too_long') return true
  if (!result.is_error) return false
  if (typeof result.result === 'string' && isPromptTooLongText(result.result)) return true
  return Array.isArray(result.errors) && result.errors.some((e) => typeof e === 'string' && isPromptTooLongText(e))
}

/** The text of a user message's content, as the CLI reads it. */
export function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Whether a turn made of these messages may be compacted and sent again. A
 * turn that was itself a `/compact` cannot: compacting again would fail the same way.
 */
export function canRetryAfterCompact(texts: readonly string[]): boolean {
  return texts.length > 0 && !texts.some((text) => COMPACT_INVOCATION.test(text))
}
