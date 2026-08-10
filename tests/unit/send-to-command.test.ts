/**
 * `/send-to <target>: <message>` parsing and target resolution.
 *
 * Both halves are pure so the failure modes are testable without a session:
 * a typo must not silently deliver to the wrong chat, and an ambiguous prefix
 * must name the candidates rather than pick one.
 */
import { describe, it, expect } from 'vitest'
import { parseSendTo, resolveSendToTarget, peerMessageToChatMessage, detectSendToTrigger, sendToPickerItems } from '../../src/renderer/components/chat/sendToCommand'
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

  // Superseded by ranking: two sessions sharing a prefix score differently, so
  // the better match wins rather than the command refusing. A genuine tie is
  // still refused - see the tie case below.
  it('picks the best match when several share a prefix', () => {
    expect(resolveSendToTarget('API refac', sessions, 't2')).toEqual({
      ok: true, id: 't1', title: 'API refactor',
    })
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

describe('resolveSendToTarget, review findings', () => {
  // Delivery runs on the sender's backend, so a remote session that resolved
  // here would fail later with a misleading "is not running".
  it('ignores sessions on another machine', () => {
    const mixed = [
      { id: 't1', title: 'API refactor', machineId: 'local' },
      { id: 't2', title: 'Docs pass', machineId: 'vm-1' },
    ]
    expect(resolveSendToTarget('Docs pass', mixed, 't1')).toEqual({
      ok: false,
      error: 'The other open chats run on a different machine. A session-to-session message stays on one backend.',
    })
  })

  it('matches a session on the sender own remote machine', () => {
    const mixed = [
      { id: 't1', title: 'API refactor', machineId: 'vm-1' },
      { id: 't2', title: 'Docs pass', machineId: 'vm-1' },
    ]
    expect(resolveSendToTarget('Docs', mixed, 't1')).toEqual({ ok: true, id: 't2', title: 'Docs pass' })
  })

  // Two subsequence hits are common ("api" hits "Add pipeline install"), so
  // refusing on any second match made the command unusable.
  it('ranks by score instead of refusing every second match', () => {
    const rivals = [
      { id: 't1', title: 'Sender' },
      { id: 't2', title: 'API refactor' },
      { id: 't3', title: 'Add pipeline install' },
    ]
    expect(resolveSendToTarget('api', rivals, 't1')).toEqual({ ok: true, id: 't2', title: 'API refactor' })
  })

  it('still refuses a genuine tie and names the candidates', () => {
    const tie = [
      { id: 't1', title: 'Sender' },
      { id: 't2', title: 'Notes' },
      { id: 't3', title: 'Notes' },
    ]
    const out = resolveSendToTarget('Notes', tie, 't1')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('"Notes", "Notes"')
  })
})

describe('resolveSendToTarget with nothing else open', () => {
  // The likeliest first-use case. "No open session matches X" reads like a
  // typo, when the real problem is that there is no second chat to message.
  it('says no other chat is open rather than blaming the name', () => {
    expect(resolveSendToTarget('anything', [{ id: 't1', title: 'Only chat' }], 't1')).toEqual({
      ok: false,
      error: 'No other chat is open. Open the chat you want to message in this window, then try again.',
    })
  })
})

describe('detectSendToTrigger', () => {
  it('fires while typing the target, before any colon', () => {
    const body = '/send-to doc'
    expect(detectSendToTrigger(body, body.length)).toEqual({ query: 'doc', start: 9, end: 12 })
  })

  it('offers every session immediately after the command', () => {
    const body = '/send-to '
    expect(detectSendToTrigger(body, body.length)).toEqual({ query: '', start: 9, end: 9 })
  })

  it('stops once the target is committed with a colon', () => {
    const body = '/send-to Docs pass: hello'
    expect(detectSendToTrigger(body, body.length)).toBeNull()
  })

  it('ignores a caret parked before the command', () => {
    expect(detectSendToTrigger('/send-to doc', 3)).toBeNull()
  })

  it('does not fire for other commands', () => {
    expect(detectSendToTrigger('/clear', 6)).toBeNull()
  })
})

describe('sendToPickerItems', () => {
  const withProjects = [
    { id: 't1', title: 'Sender', projectPath: '/Users/x/switchboard' },
    { id: 't2', title: 'Issue 172', projectPath: '/Users/x/tejasnafde.github.io' },
    { id: 't3', title: 'cohesive website', projectPath: '/Users/x/tejasnafde.github.io' },
  ]

  // Titles alone were unreadable: the screenshot had "Issue 172" twice and
  // "v0" twice with nothing to tell them apart.
  it('labels each chat with its project folder', () => {
    expect(sendToPickerItems(withProjects, 't1')).toEqual([
      { id: 't2', label: 'Issue 172 · tejasnafde.github.io' },
      { id: 't3', label: 'cohesive website · tejasnafde.github.io' },
    ])
  })

  it('excludes the sending chat', () => {
    expect(sendToPickerItems(withProjects, 't2').some((i) => i.id === 't2')).toBe(false)
  })

  // Same title AND same project happens (two chats opened on one issue), and
  // an identical label would make the pick arbitrary.
  it('disambiguates chats whose title and project both collide', () => {
    const dupes = [
      { id: 'sender', title: 'Sender', projectPath: '/p/one' },
      { id: 'abc12345', title: '10aug issues', projectPath: '/p/two' },
      { id: 'def67890', title: '10aug issues', projectPath: '/p/two' },
    ]
    expect(sendToPickerItems(dupes, 'sender').map((i) => i.label)).toEqual([
      '10aug issues · two (abc1)',
      '10aug issues · two (def6)',
    ])
  })

  it('falls back to the id when a chat has no title', () => {
    const untitled = [
      { id: 'sender', title: undefined, projectPath: '/p/one' },
      { id: 'agent_9', title: undefined, projectPath: '/p/two' },
    ]
    expect(sendToPickerItems(untitled, 'sender')).toEqual([
      { id: 'agent_9', label: 'agent_9 · two' },
    ])
  })

  it('keeps only chats on the sender machine', () => {
    const mixed = [
      { id: 't1', title: 'Sender', projectPath: '/p/one', machineId: 'local' },
      { id: 't2', title: 'Remote', projectPath: '/p/two', machineId: 'vm-1' },
    ]
    expect(sendToPickerItems(mixed, 't1')).toEqual([])
  })
})

describe('resolveSendToTarget by id', () => {
  // The picker inserts `#<id>` rather than a title: two chats can share a
  // title, and the pick has already decided which one the user meant.
  it('resolves an exact id reference', () => {
    expect(resolveSendToTarget('#t2', sessions, 't1')).toEqual({ ok: true, id: 't2', title: 'Docs pass' })
  })

  it('refuses an id that is not open, without falling back to fuzzy', () => {
    expect(resolveSendToTarget('#gone', sessions, 't1')).toEqual({
      ok: false, error: 'That chat is no longer open. Pick another with /send-to.',
    })
  })

  it('never resolves an id back to the sending chat', () => {
    expect(resolveSendToTarget('#t1', sessions, 't1')).toEqual({
      ok: false, error: 'That chat is no longer open. Pick another with /send-to.',
    })
  })
})
