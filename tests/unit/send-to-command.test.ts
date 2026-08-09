/**
 * `/send-to <target>: <message>` parsing and target resolution.
 *
 * Both halves are pure so the failure modes are testable without a session:
 * a typo must not silently deliver to the wrong chat, and an ambiguous prefix
 * must name the candidates rather than pick one.
 */
import { describe, it, expect } from 'vitest'
import { parseSendTo, resolveSendToTarget, peerMessageToChatMessage } from '../../src/renderer/components/chat/sendToCommand'
import { PEER_SENT_MARKER_PREFIX, wrapPeerMessage } from '../../src/shared/peer-messaging'

const sessions = [
  { id: 't1', title: 'API refactor' },
  { id: 't2', title: 'Docs pass' },
  { id: 't3', title: 'API cleanup' },
]

describe('parseSendTo', () => {
  it('splits the target from the message on the first colon', () => {
    expect(parseSendTo('/send-to Docs pass: the migration landed')).toEqual({
      ok: true, target: 'Docs pass', text: 'the migration landed',
    })
  })

  it('keeps colons inside the message body', () => {
    const parsed = parseSendTo('/send-to Docs: see src/main/db/database.ts:747')
    expect(parsed).toEqual({ ok: true, target: 'Docs', text: 'see src/main/db/database.ts:747' })
  })

  it('rejects a command with no colon', () => {
    expect(parseSendTo('/send-to Docs pass the migration landed')).toEqual({
      ok: false, error: 'Use /send-to <session>: <message>',
    })
  })

  it('rejects an empty message', () => {
    expect(parseSendTo('/send-to Docs pass:   ')).toEqual({
      ok: false, error: 'Nothing to send. Use /send-to <session>: <message>',
    })
  })

  it('rejects an empty target', () => {
    expect(parseSendTo('/send-to : hello')).toEqual({
      ok: false, error: 'Name a session. Use /send-to <session>: <message>',
    })
  })

  it('is not a send-to command at all', () => {
    expect(parseSendTo('/clear')).toBeNull()
  })
})

describe('resolveSendToTarget', () => {
  it('resolves an exact title', () => {
    expect(resolveSendToTarget('Docs pass', sessions, 't1')).toEqual({ ok: true, id: 't2', title: 'Docs pass' })
  })

  it('resolves a unique fuzzy match', () => {
    expect(resolveSendToTarget('docs', sessions, 't1')).toEqual({ ok: true, id: 't2', title: 'Docs pass' })
  })

  it('refuses an ambiguous match and names the candidates', () => {
    const out = resolveSendToTarget('API', sessions, 't2')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('API refactor')
    expect(out.ok === false && out.error).toContain('API cleanup')
  })

  it('refuses when nothing matches', () => {
    expect(resolveSendToTarget('kanban', sessions, 't1')).toEqual({
      ok: false, error: 'No open session matches "kanban".',
    })
  })

  it('never resolves to the sending session', () => {
    expect(resolveSendToTarget('Docs pass', sessions, 't2')).toEqual({
      ok: false, error: 'No open session matches "Docs pass".',
    })
  })

  it('prefers an exact title over a fuzzy rival', () => {
    const withRival = [...sessions, { id: 't4', title: 'Docs pass follow-up' }]
    expect(resolveSendToTarget('Docs pass', withRival, 't1')).toEqual({ ok: true, id: 't2', title: 'Docs pass' })
  })
})

describe('peerMessageToChatMessage', () => {
  const base = {
    type: 'peer.message' as const,
    messageId: 'pm_abc123',
    text: 'the auth migration landed',
    at: 1700,
  }

  // Ids must match what the backend persisted, or a reload renders the same
  // delivery twice: once from the live event, once from the stored row.
  it('renders the sender side as the persisted marker', () => {
    const msg = peerMessageToChatMessage({
      ...base, threadId: 'sender', direction: 'sent',
      peerThreadId: 'target', peerLabel: 'API refactor',
    }, 'Docs pass')
    expect(msg).toEqual({
      id: 'peer_pm_abc123',
      role: 'system',
      content: `${PEER_SENT_MARKER_PREFIX} Docs pass → API refactor`,
      timestamp: 1700,
    })
  })

  it('renders the received side as the wrapped turn under the backend id', () => {
    const msg = peerMessageToChatMessage({
      ...base, threadId: 'target', direction: 'received',
      peerThreadId: 'sender', peerLabel: 'Docs pass',
    }, 'API refactor')
    expect(msg.id).toBe('pm_abc123')
    expect(msg.role).toBe('user')
    expect(msg.content).toBe(wrapPeerMessage('Docs pass', 'the auth migration landed'))
  })

  // The bubble must say where it came from, or it reads as the user's own turn.
  it('labels the received bubble with its origin', () => {
    const msg = peerMessageToChatMessage({
      ...base, threadId: 'target', direction: 'received',
      peerThreadId: 'sender', peerLabel: 'Docs pass',
    }, 'API refactor')
    expect(msg.displayBody).toBe('From "Docs pass": the auth migration landed')
  })
})
