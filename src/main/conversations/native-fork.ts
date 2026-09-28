import { normalizeCodexEvent } from '../agent/jsonl-parser'
import { createMainLogger } from '../logger'

const log = createMainLogger('conversations:native-fork')

export type CodexForkTurn =
  | { ok: true; turnId: string }
  | { ok: false; code: string; message: string }

function turnIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Find the Codex turn to fork through (`thread/fork` `lastTurnId`, inclusive)
 * for an anchor message in a rollout JSONL.
 *
 * A turn is atomic to Codex, so the fork is native only when it holds exactly
 * what the fork shows: the anchor is an assistant reply that ends its turn,
 * and the thread's visible messages up to it are the whole displayed prefix
 * (an earlier thread of the same chat, or a message Codex never saw, means
 * the thread alone would drop context). Message ids come from
 * `normalizeCodexEvent`, the same function the history loader uses. The
 * prefix is matched by role and text, not id: a fork's stored prefix has
 * fresh ids while its forked rollout keeps Codex's.
 */
export function findCodexForkTurn(
  rollout: string,
  anchorMessageId: string,
  prefix: ReadonlyArray<{ role: string; content: string }>,
): CodexForkTurn {
  const messages: Array<{ id: string; role: string; content: string; turnId: string | null }> = []
  let currentTurn: string | null = null
  for (const line of rollout.split('\n')) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A torn last line while Codex is still writing; the rest is intact.
      log.debug('skipping an unparseable rollout line', { length: line.length })
      continue
    }
    const payload = event.payload as Record<string, unknown> | undefined
    if (event.type === 'turn_context') currentTurn = turnIdOf(payload?.turn_id) ?? currentTurn
    if (event.type === 'event_msg' && payload?.type === 'task_started') {
      currentTurn = turnIdOf(payload.turn_id) ?? currentTurn
    }
    const message = normalizeCodexEvent(event)
    if (!message) continue
    const passthrough = payload?.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined
    messages.push({ id: message.id, role: message.role, content: message.content, turnId: turnIdOf(passthrough?.turn_id) ?? currentTurn })
  }

  const matches = messages.filter((message) => message.id === anchorMessageId)
  if (matches.length !== 1) {
    return { ok: false, code: 'native-history-missing', message: 'The selected message was not found once in the Codex thread.' }
  }
  const index = messages.indexOf(matches[0])
  const anchor = matches[0]
  if (!anchor.turnId) {
    return { ok: false, code: 'native-turn-missing', message: 'The Codex thread does not record a turn id for the selected message.' }
  }
  const next = messages[index + 1]
  if (anchor.role !== 'assistant' || next?.turnId === anchor.turnId) {
    return { ok: false, code: 'native-anchor-mid-turn', message: 'Codex forks whole turns, and the selected message does not end one.' }
  }
  if (index + 1 !== prefix.length || prefix.some((expected, at) =>
    messages[at].role !== expected.role || messages[at].content !== expected.content)) {
    return { ok: false, code: 'native-lineage-incompatible', message: 'The Codex thread does not hold the whole conversation up to the selected message.' }
  }
  return { ok: true, turnId: anchor.turnId }
}

/** Thrown when the CLI lacks a native fork, so the caller falls back quietly. */
export class NativeForkUnsupportedError extends Error {}

/**
 * Detect a CLI that does not know a method. Codex's app-server answers an
 * unknown method with -32600 "unknown variant `thread/fork`" rather than
 * JSON-RPC's -32601, so both are checked; never the version string.
 */
export function isUnsupportedMethodError(error: unknown, method: string): boolean {
  if (error instanceof NativeForkUnsupportedError) return true
  if ((error as { code?: unknown } | null)?.code === -32601) return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(`unknown variant \`${method}\``) || /method not found/i.test(message)
}

export interface OpencodeForkSegment {
  provider: string
  provider_session_id: string
  provider_instance_id: string | null
  created_at: number
}

/** How much later than the chat's first message its OpenCode session may be recorded. */
const OPENCODE_SESSION_START_SKEW_MS = 60_000

export type OpencodeForkSession =
  | { ok: true; sessionId: string }
  | { ok: false; code: string; message: string }

/**
 * OpenCode's ACP fork copies the WHOLE session (1.18.33 calls
 * `session.fork` without a message id), so it is native only for the latest
 * reply, and only when one OpenCode session, started with the chat, holds
 * all of it. A chat older than session recording, or one whose session was
 * replaced, has earlier turns that session never saw.
 */
export function pickOpencodeForkSession(input: {
  segments: readonly OpencodeForkSegment[]
  instanceId: string
  firstMessageAt: number | undefined
  anchor: { role: string; canonicalIndex: number; canonicalMessageCount: number }
}): OpencodeForkSession {
  const { anchor } = input
  if (anchor.canonicalIndex !== anchor.canonicalMessageCount - 1) {
    return { ok: false, code: 'native-anchor-not-latest', message: 'OpenCode forks whole sessions, so only the latest message forks natively.' }
  }
  if (anchor.role !== 'assistant') {
    return { ok: false, code: 'native-anchor-mid-turn', message: 'OpenCode forks natively only after a finished reply.' }
  }
  const [segment, ...rest] = input.segments
  if (!segment || rest.length > 0 || segment.provider !== 'opencode' || segment.provider_instance_id !== input.instanceId) {
    return { ok: false, code: 'native-lineage-incompatible', message: 'More than one agent session holds this conversation.' }
  }
  if (input.firstMessageAt === undefined || segment.created_at > input.firstMessageAt + OPENCODE_SESSION_START_SKEW_MS) {
    return { ok: false, code: 'native-lineage-incompatible', message: 'The OpenCode session started after the conversation did.' }
  }
  return { ok: true, sessionId: segment.provider_session_id }
}
