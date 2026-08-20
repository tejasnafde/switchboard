/**
 * Cross-provider context handoff ("preamble replay").
 *
 * Switching agent provider mid-chat, or forking a Codex / OpenCode
 * conversation, starts the new adapter process with zero context even
 * though the visible transcript survives. The proven mitigation is to
 * prefix the first turn sent to the new adapter with a plain-text replay
 * of the conversation so far. This module is the pure core: it renders
 * that preamble and decides when a switch should schedule one.
 *
 * Rules baked in here (each one was learned the expensive way upstream):
 * - Only user and assistant TEXT turns are replayed. Tool calls, tool
 *   outputs, reasoning and system markers confuse the model when echoed
 *   back as prose.
 * - Images are never serialized into the preamble (base64 in text blew a
 *   replay up to millions of tokens). Each becomes an `[image omitted]`
 *   placeholder line.
 * - Total size is capped; oldest turns drop first, with a one-line
 *   truncation notice so the model knows the transcript is partial.
 * - Deterministic: no clock, no randomness.
 *
 * No node / electron / react imports - consumed by both the renderer
 * (ChatPanel injection) and main (fork wiring tests).
 */

export const HANDOFF_PREAMBLE_HEADER = 'Conversation so far:'
export const HANDOFF_PREAMBLE_FOOTER =
  'Respond to the latest user message, using the conversation above as context.'
const TRUNCATION_NOTICE_START = '(Earlier conversation truncated:'

/** Default cap on the rendered preamble, in characters (~7.5k tokens). */
export const DEFAULT_HANDOFF_MAX_CHARS = 30_000

/** Minimal structural view of a chat message - matches ChatMessage. */
export interface HandoffSourceMessage {
  role: string
  content: string
  images?: ReadonlyArray<unknown>
}

export interface HandoffPreambleOpts {
  /** Cap on the total rendered preamble length. Oldest turns drop first. */
  maxChars?: number
}

/**
 * Render the transcript preamble, or null when the history holds no
 * replayable turns (empty conversation, or system/tool traffic only).
 * The caller sends `preamble + '\n\n' + userMessage` as the wire message.
 */
export function buildHandoffPreamble(
  messages: ReadonlyArray<HandoffSourceMessage>,
  opts: HandoffPreambleOpts = {},
): string | null {
  const maxChars = opts.maxChars ?? DEFAULT_HANDOFF_MAX_CHARS
  const turns: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    // A user turn that itself carried an injected preamble (a second
    // handoff later in the same chat) replays only the user's own text,
    // otherwise preambles nest and the size doubles per handoff.
    const raw = m.role === 'user' ? stripHandoffPreamble(m.content ?? '') : (m.content ?? '')
    const text = raw.trim()
    const imageNotes = m.images && m.images.length > 0
      ? Array.from({ length: m.images.length }, () => '[image omitted]').join('\n')
      : ''
    const body = [text, imageNotes].filter(Boolean).join('\n')
    if (!body) continue // interrupted / tool-only / empty partial turn
    turns.push(`${m.role}: ${body}`)
  }
  if (turns.length === 0) return null

  const render = (omitted: number, kept: string[]): string => {
    const notice = omitted > 0
      ? `${TRUNCATION_NOTICE_START} ${omitted} older turn${omitted === 1 ? '' : 's'} omitted.)\n`
      : ''
    return `${notice}${HANDOFF_PREAMBLE_HEADER}\n${kept.join('\n')}\n\n${HANDOFF_PREAMBLE_FOOTER}`
  }

  let omitted = 0
  const kept = [...turns]
  while (kept.length > 1 && render(omitted, kept).length > maxChars) {
    kept.shift()
    omitted++
  }
  let out = render(omitted, kept)
  if (out.length > maxChars) {
    // A single turn larger than the whole budget: keep its tail (the
    // newest text is the most relevant) so the cap still holds.
    const overshoot = out.length - maxChars
    kept[0] = kept[0].slice(0, Math.max(0, kept[0].length - overshoot))
    out = render(omitted, kept)
  }
  return out
}

/**
 * Remove an injected preamble from a wire message, returning the user's
 * own trailing text. No-op for messages that never carried one.
 */
export function stripHandoffPreamble(text: string): string {
  if (!text.startsWith(HANDOFF_PREAMBLE_HEADER) && !text.startsWith(TRUNCATION_NOTICE_START)) {
    return text
  }
  const footerAt = text.lastIndexOf(HANDOFF_PREAMBLE_FOOTER)
  if (footerAt === -1) return text
  return text.slice(footerAt + HANDOFF_PREAMBLE_FOOTER.length).replace(/^\n+/, '')
}

/**
 * Should a provider switch schedule a handoff preamble for the next turn?
 * Pure so the renderer flow stays testable: true only for a real switch
 * (both providers known, different) over an existing history that has not
 * already been handed off.
 */
export function shouldInjectHandoff(
  prevProvider: string | null | undefined,
  nextProvider: string | null | undefined,
  hasHistory: boolean,
  alreadyInjected: boolean,
): boolean {
  if (!prevProvider || !nextProvider) return false
  if (prevProvider === nextProvider) return false
  if (!hasHistory) return false
  return !alreadyInjected
}

/**
 * Fold a provider switch into the persisted pending-handoff state.
 *
 * `existing` is the currently pending source provider (null when none).
 * Returns the value to persist:
 * - switching back to the pending source clears it - that provider resumes
 *   its own native context, so a preamble would only add noise;
 * - a chain of switches before any send keeps the ORIGINAL source, since
 *   that is the provider whose context the history actually holds;
 * - otherwise a qualifying switch records `prevProvider`.
 */
export function nextPendingHandoffFrom(
  existing: string | null,
  prevProvider: string | null | undefined,
  nextProvider: string | null | undefined,
  hasHistory: boolean,
): string | null {
  if (existing && nextProvider === existing) return null
  if (existing) return existing
  if (shouldInjectHandoff(prevProvider, nextProvider, hasHistory, false)) return prevProvider!
  return null
}
