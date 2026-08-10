/**
 * `/send-to <session>: <message>` - parsing and target resolution.
 *
 * Pure, because both failure modes are the interesting ones: a typo must not
 * deliver to the wrong chat, and an ambiguous prefix must name its candidates
 * instead of picking one.
 */
import { fuzzyScore } from '../../services/fuzzyScore'
import { PEER_SENT_MARKER_PREFIX, wrapPeerMessage } from '@shared/peer-messaging'
import type { RuntimePeerMessageEvent } from '@shared/provider-events'
import type { ChatMessage } from '@shared/types'

export const SEND_TO_USAGE = 'Use /send-to <session>: <message>'

export type SendToParse =
  | { ok: true; target: string; text: string }
  | { ok: false; error: string }

export interface SendToSession {
  id: string
  title: string
  /** Backend this session runs on. Delivery is same-backend only. */
  machineId?: string
}

export type SendToTarget =
  | { ok: true; id: string; title: string }
  | { ok: false; error: string }

/**
 * Split a composer body into target and message, or null when the body is not
 * a `/send-to` command at all. The FIRST colon separates them, so a message
 * may contain `file.ts:120` without confusing the split.
 */
export function parseSendTo(body: string): SendToParse | null {
  const match = /^\/send-to\b\s*(.*)$/s.exec(body.trim())
  if (!match) return null

  const rest = match[1]
  const colon = rest.indexOf(':')
  if (colon === -1) return { ok: false, error: SEND_TO_USAGE }

  const target = rest.slice(0, colon).trim()
  const text = rest.slice(colon + 1).trim()
  if (!target) return { ok: false, error: `Name a session. ${SEND_TO_USAGE}` }
  if (!text) return { ok: false, error: `Nothing to send. ${SEND_TO_USAGE}` }
  return { ok: true, target, text }
}

/**
 * Resolve a typed target to one open session, excluding the sender (a session
 * messaging itself is always a mistake, and would loop).
 */
export function resolveSendToTarget(
  target: string,
  sessions: ReadonlyArray<SendToSession>,
  fromSessionId: string,
): SendToTarget {
  // Delivery runs on the sender's backend, so a session on another machine
  // could resolve here and then fail as "not running", which reads like a bug
  // rather than a limit. Exclude them from matching instead.
  const from = sessions.find((s) => s.id === fromSessionId)
  const candidates = sessions.filter(
    (s) => s.id !== fromSessionId && (s.machineId ?? 'local') === (from?.machineId ?? 'local'),
  )
  // "Nothing to match against" is not "nothing matched": first-time use hits
  // the former, and blaming the name sends the user hunting for a typo.
  if (candidates.length === 0) {
    const elsewhere = sessions.some((s) => s.id !== fromSessionId)
    return {
      ok: false,
      error: elsewhere
        ? 'The other open chats run on a different machine. A session-to-session message stays on one backend.'
        : 'No other chat is open. Open the chat you want to message in this window, then try again.',
    }
  }
  // `#<id>` is what the picker inserts. It is exact by construction, so it
  // must never fall through to fuzzy matching on the id string.
  if (target.startsWith('#')) {
    const byId = candidates.find((s) => s.id === target.slice(1))
    return byId
      ? { ok: true, id: byId.id, title: byId.title }
      : { ok: false, error: 'That chat is no longer open. Pick another with /send-to.' }
  }
  const query = target.toLowerCase()

  const exact = candidates.filter((s) => s.title.toLowerCase() === query)
  if (exact.length === 1) return { ok: true, id: exact[0].id, title: exact[0].title }

  const scored = candidates
    .map((s) => ({ session: s, score: fuzzyScore(target, s.title) }))
    .filter((c): c is { session: SendToSession; score: number } => c.score !== null)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return { ok: false, error: `No open session matches "${target}".` }
  // Rank rather than refuse on any second subsequence hit: "api" legitimately
  // matches "API refactor" and "Add pipeline install". Only a genuine tie is
  // ambiguous, and then the candidates are named.
  const tied = scored.filter((c) => c.score === scored[0].score)
  if (tied.length > 1) {
    const names = tied.map((c) => `"${c.session.title}"`).join(', ')
    return { ok: false, error: `"${target}" matches several sessions: ${names}. Be more specific.` }
  }
  return { ok: true, id: scored[0].session.id, title: scored[0].session.title }
}

/**
 * The bubble a `peer.message` event appends, for whichever side of the
 * delivery this thread is on. Ids match the rows the registry persisted, so
 * the live bubble and the stored one are the same message and a reload cannot
 * render the delivery twice. `ownLabel` supplies the half of the sender
 * marker's `<from> → <to>` shape the event does not carry.
 */
export function peerMessageToChatMessage(
  event: RuntimePeerMessageEvent,
  ownLabel: string,
): ChatMessage {
  if (event.direction === 'sent') {
    return {
      id: `peer_${event.messageId}`,
      role: 'system',
      content: `${PEER_SENT_MARKER_PREFIX} ${ownLabel} → ${event.peerLabel}`,
      timestamp: event.at,
    }
  }
  return {
    id: event.messageId,
    role: 'user',
    content: wrapPeerMessage(event.peerLabel, event.text),
    // The wire body carries an instruction block the user never typed, so the
    // bubble shows the provenance line instead - same convention the handoff
    // preamble uses.
    displayBody: `From "${event.peerLabel}": ${event.text}`,
    timestamp: event.at,
  }
}

/** Span of the target being typed in `/send-to <target>`, or null. */
export interface SendToTrigger {
  query: string
  start: number
  end: number
}

/**
 * True when the caret sits in the TARGET half of `/send-to`, so the composer
 * can offer the open chats. A colon commits the target and ends the trigger.
 */
export function detectSendToTrigger(body: string, caret: number): SendToTrigger | null {
  const prefix = '/send-to '
  if (!body.startsWith(prefix)) return null
  if (caret < prefix.length) return null
  const target = body.slice(prefix.length, caret)
  if (target.includes(':')) return null
  return { query: target, start: prefix.length, end: caret }
}

/** One row of the `/send-to` target picker. */
export interface SendToPickerItem {
  id: string
  label: string
}

/** A store session as the picker sees it: title and project may be absent. */
export interface SendToPickerSession {
  id: string
  title?: string
  projectPath?: string
  machineId?: string
}

/**
 * Rows for the target picker, labelled `<title> · <project folder>`.
 *
 * Titles alone were ambiguous in practice: several chats share one ("Issue
 * 172" twice, "v0" twice), and a bare list gave no way to tell them apart.
 * When title AND project both collide, a short id suffix breaks the tie so
 * the pick is never arbitrary.
 */
export function sendToPickerItems(
  sessions: ReadonlyArray<SendToPickerSession>,
  fromSessionId: string,
): SendToPickerItem[] {
  const from = sessions.find((s) => s.id === fromSessionId)
  const rows = sessions
    .filter((s) => s.id !== fromSessionId && (s.machineId ?? 'local') === (from?.machineId ?? 'local'))
    .map((s) => ({
      id: s.id,
      base: `${s.title ?? s.id} · ${s.projectPath?.split('/').filter(Boolean).pop() ?? 'unknown'}`,
    }))
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.base, (counts.get(r.base) ?? 0) + 1)
  return rows.map((r) => ({
    id: r.id,
    label: (counts.get(r.base) ?? 0) > 1 ? `${r.base} (${r.id.slice(0, 4)})` : r.base,
  }))
}
