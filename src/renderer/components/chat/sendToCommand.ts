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
  const candidates = sessions.filter((s) => s.id !== fromSessionId)
  const query = target.toLowerCase()

  const exact = candidates.filter((s) => s.title.toLowerCase() === query)
  if (exact.length === 1) return { ok: true, id: exact[0].id, title: exact[0].title }

  const scored = candidates
    .map((s) => ({ session: s, score: fuzzyScore(target, s.title) }))
    .filter((c): c is { session: SendToSession; score: number } => c.score !== null)

  if (scored.length === 0) return { ok: false, error: `No open session matches "${target}".` }
  if (scored.length > 1) {
    const names = scored.map((c) => `"${c.session.title}"`).join(', ')
    return { ok: false, error: `"${target}" matches several sessions: ${names}. Be more specific.` }
  }
  return { ok: true, id: scored[0].session.id, title: scored[0].session.title }
}

/**
 * The bubble a `peer.message` event should append, for whichever side of the
 * delivery this thread is on.
 *
 * Ids match what the backend already persisted (`saveMessageIfAbsent` in the
 * registry), so the live bubble and the stored row are the same message and a
 * reload cannot render the delivery twice.
 *
 * `ownLabel` is this thread's own title, needed for the sender marker's
 * `<from> → <to>` shape which the event only carries one half of.
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
