/**
 * Cross-provider context handoff ("preamble replay").
 *
 * Switching agent provider mid-chat, or forking a Codex / OpenCode
 * conversation, starts the new adapter process with zero context even
 * though the visible transcript survives. The mitigation is to prefix the
 * first turn sent to the new adapter with a plain-text replay of the
 * conversation so far. This module is the pure core: it renders that
 * preamble and decides when a switch should schedule one. The backend
 * builds it (`ProviderRegistry`); older backends leave it to the client.
 *
 * Rules baked in here (each one was learned the expensive way upstream):
 * - User and assistant text, plus each tool call (name, input, output) and
 *   error row in compact form. Reasoning and other system markers are left
 *   out: they confuse the model when echoed back as prose.
 * - Images are never serialized into the preamble (base64 in text blew a
 *   replay up to millions of tokens). Each becomes an `[image omitted]`
 *   placeholder line.
 * - A provider returning to a chat it already took part in resumes its own
 *   native session, so it gets only the turns since it left (`since`).
 * - Total size is capped. Whole turns are kept, newest first; the first user
 *   message is pinned and dropped only when nothing else is left to drop; a
 *   one-line notice says how many older turns were left out. A newest turn
 *   larger than the whole budget keeps its tail, the newest text.
 * - Deterministic: no clock, no randomness.
 *
 * No node / electron / react imports - consumed by the backend, the
 * renderer and the Expo app.
 */

import { AGENT_SWITCH_MARKER_PREFIX, CONTEXT_HANDOFF_MARKER_PREFIX, parseRotationMarker } from './rotation-marker'
import { agentLabel, isAgentProvider, type AgentProvider } from './types'

export const HANDOFF_PREAMBLE_HEADER = 'Conversation so far:'
/** Header of a delta handoff: the target already holds what came before. */
export const HANDOFF_DELTA_HEADER = 'Conversation since you last took part (you already have the earlier part):'
export const HANDOFF_PREAMBLE_FOOTER =
  'Respond to the latest user message, using the conversation above as context.'
const TRUNCATION_NOTICE_START = '(Earlier conversation truncated:'
const CUT_MARK = '[start cut] '

/** Default cap on the rendered preamble, in characters (~7.5k tokens). */
export const DEFAULT_HANDOFF_MAX_CHARS = 30_000
/** Never more than this many tokens of replay, however large the window. */
const HANDOFF_MAX_TOKENS = 32_000
/** Conservative: real text averages closer to 4 characters per token. */
const CHARS_PER_TOKEN = 3
const TOOL_INPUT_CHARS = 200
const TOOL_OUTPUT_CHARS = 400
const ERROR_CHARS = 400

/** Minimal structural view of a chat message - matches ChatMessage. */
export interface HandoffSourceMessage {
  role: string
  content: string
  images?: ReadonlyArray<unknown>
  toolCalls?: ReadonlyArray<{ name: string; input?: string; output?: string }>
}

export interface HandoffPreambleOpts {
  /** Cap on the total rendered preamble length. Oldest turns drop first. */
  maxChars?: number
  /**
   * Replay only `messages[since..]` (a delta for a provider that already
   * holds the earlier part natively, see `handoffDeltaStart`).
   */
  since?: number
}

/**
 * Character budget for a handoff to a model with `contextWindowTokens`
 * (a quarter of the window, at most 32k tokens), or the default cap when the
 * window is unknown.
 */
export function handoffBudgetChars(contextWindowTokens?: number | null): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_HANDOFF_MAX_CHARS
  return Math.min(Math.floor(contextWindowTokens / 4), HANDOFF_MAX_TOKENS) * CHARS_PER_TOKEN
}

/**
 * Where a delta handoff to `targetLabel` (an `agentLabel`) starts: the
 * message after the newest agent-switch marker that switched AWAY from it,
 * i.e. the first turn it has not seen. Null when it never took part, which
 * means it needs the whole conversation.
 */
export function handoffDeltaStart(
  messages: ReadonlyArray<HandoffSourceMessage>,
  targetLabel: string,
): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'system' || !m.content.startsWith(AGENT_SWITCH_MARKER_PREFIX)) continue
    if (parseRotationMarker(m.content)?.fromName === targetLabel) return i + 1
  }
  return null
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function renderItem(m: HandoffSourceMessage): string | null {
  if (m.role === 'system') {
    // Error rows only; every other system row is a Switchboard marker or notice.
    return /^error:/i.test(m.content) ? `error: ${clip(m.content.replace(/^error:\s*/i, ''), ERROR_CHARS)}` : null
  }
  if (m.role !== 'user' && m.role !== 'assistant') return null
  // A user turn that itself carried an injected preamble (a second
  // handoff later in the same chat) replays only the user's own text,
  // otherwise preambles nest and the size doubles per handoff.
  const raw = m.role === 'user' ? stripHandoffPreamble(m.content ?? '') : (m.content ?? '')
  const lines = [raw.trim()]
  for (let i = 0; i < (m.images?.length ?? 0); i++) lines.push('[image omitted]')
  for (const tool of m.toolCalls ?? []) {
    const input = tool.input ? ` ${clip(tool.input, TOOL_INPUT_CHARS)}` : ''
    const output = tool.output ? ` -> ${clip(tool.output, TOOL_OUTPUT_CHARS)}` : ''
    lines.push(`[tool ${tool.name}]${input}${output}`)
  }
  const body = lines.filter(Boolean).join('\n')
  return body ? `${m.role}: ${body}` : null // interrupted / empty partial turn
}

/**
 * Render the transcript preamble, or null when the history holds no
 * replayable turns (empty conversation, or nothing new for a delta).
 * The caller sends `preamble + '\n\n' + userMessage` as the wire message.
 */
export function buildHandoffPreamble(
  messages: ReadonlyArray<HandoffSourceMessage>,
  opts: HandoffPreambleOpts = {},
): string | null {
  const maxChars = opts.maxChars ?? DEFAULT_HANDOFF_MAX_CHARS
  const delta = opts.since !== undefined
  const header = delta ? HANDOFF_DELTA_HEADER : HANDOFF_PREAMBLE_HEADER
  const items: Array<{ text: string; user: boolean }> = []
  for (const m of messages.slice(opts.since ?? 0)) {
    const text = renderItem(m)
    if (text) items.push({ text, user: m.role === 'user' })
  }
  if (items.length === 0) return null

  const render = (omitted: number, kept: string[]): string => {
    const notice = omitted > 0
      ? `${TRUNCATION_NOTICE_START} ${omitted} older turn${omitted === 1 ? '' : 's'} omitted.)\n`
      : ''
    return `${notice}${header}\n${kept.join('\n')}\n\n${HANDOFF_PREAMBLE_FOOTER}`
  }

  // A delta's first message is not the conversation's, so nothing is pinned.
  const pinned = delta ? -1 : items.findIndex((item) => item.user)
  const texts = items.map((item) => item.text)
  // Newest first: take whole turns while they fit, the pinned one reserved.
  const keep = new Set<number>()
  if (pinned >= 0) keep.add(pinned)
  const fits = () => render(items.length - keep.size, texts.filter((_, i) => keep.has(i))).length <= maxChars
  for (let i = items.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue
    keep.add(i)
    if (!fits()) {
      keep.delete(i)
      break
    }
  }
  const newest = items.length - 1
  if (!keep.has(newest)) {
    // Even the pinned message and the newest turn do not fit together:
    // the newest wins, cut down to its tail below if it has to be.
    keep.clear()
    keep.add(newest)
  }
  const kept = texts.filter((_, i) => keep.has(i))
  const omitted = items.length - keep.size
  let out = render(omitted, kept)
  if (out.length > maxChars) {
    // A single turn larger than the whole budget: keep its tail (the
    // newest text is the most relevant) so the cap still holds.
    const last = kept.length - 1
    const role = kept[last].slice(0, kept[last].indexOf(': ') + 2)
    const room = Math.max(0, kept[last].length - (out.length - maxChars) - role.length - CUT_MARK.length)
    kept[last] = `${role}${CUT_MARK}${kept[last].slice(kept[last].length - room)}`
    out = render(omitted, kept)
  }
  return out
}

/** A provider a handoff can come from: an agent, or a Cursor import. */
export type HandoffSource = AgentProvider | 'cursor'

export function isHandoffSource(value: string): value is HandoffSource {
  return isAgentProvider(value) || value === 'cursor'
}

/**
 * The handoff a turn to `target` needs while `pendingFrom` is scheduled. A
 * provider that resumed its own native session and has taken part before
 * gets only the turns since it left (a delta); otherwise the whole
 * conversation. `preamble` is null when there is nothing to replay.
 */
export function planTurnHandoff(input: {
  messages: ReadonlyArray<HandoffSourceMessage>
  pendingFrom: HandoffSource
  target: AgentProvider
  resumedNatively: boolean
  maxChars?: number
}): { preamble: string | null; markerText: string } {
  const { pendingFrom, target } = input
  const since = pendingFrom !== target && input.resumedNatively
    ? handoffDeltaStart(input.messages, agentLabel(target))
    : null
  return {
    preamble: buildHandoffPreamble(input.messages, { maxChars: input.maxChars, ...(since !== null ? { since } : {}) }),
    markerText: pendingFrom === target
      ? `${CONTEXT_HANDOFF_MARKER_PREFIX} ${agentLabel(target)} profile restarted with visible history`
      : `${CONTEXT_HANDOFF_MARKER_PREFIX} ${agentLabel(pendingFrom)} → ${agentLabel(target)}`,
  }
}

/**
 * History an agent that lost its native session must be given again: all of
 * it except the trailing user messages it has not answered, which are about
 * to be sent to it as themselves.
 */
export function answeredHistory<T extends HandoffSourceMessage>(messages: ReadonlyArray<T>): T[] {
  let end = messages.length
  while (end > 0 && messages[end - 1].role !== 'assistant') end--
  return messages.slice(0, end)
}

/** `message` with `preamble` in front, replacing any preamble it already carried. */
export function withHandoffPreamble(message: string, preamble: string): string {
  return `${preamble}\n\n${stripHandoffPreamble(message)}`
}

/**
 * Remove an injected preamble from a wire message, returning the user's
 * own trailing text. No-op for messages that never carried one.
 */
export function stripHandoffPreamble(text: string): string {
  if (
    !text.startsWith(HANDOFF_PREAMBLE_HEADER)
    && !text.startsWith(HANDOFF_DELTA_HEADER)
    && !text.startsWith(TRUNCATION_NOTICE_START)
  ) {
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
