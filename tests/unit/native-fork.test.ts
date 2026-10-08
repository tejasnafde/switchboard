import { describe, expect, it } from 'vitest'
import {
  findCodexForkTurn,
  isUnsupportedMethodError,
  NativeForkUnsupportedError,
  pickOpencodeForkSession,
} from '../../src/main/conversations/native-fork'

const T1 = 'turn-1'
const T2 = 'turn-2'
const line = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-09-24T10:00:00.000Z', type, payload })
const user = (text: string) =>
  line('response_item', { type: 'message', role: 'user', id: `u-${text}`, content: [{ type: 'input_text', text }] })
const assistant = (id: string, text: string) =>
  line('response_item', { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] })

const rollout = [
  line('session_meta', { id: 'thread', cwd: '/repo' }),
  line('turn_context', { turn_id: T1 }),
  line('event_msg', { type: 'task_started', turn_id: T1 }),
  user('one'),
  assistant('a1-interim', 'working'),
  assistant('a1', 'first answer'),
  line('event_msg', { type: 'task_complete', turn_id: T1 }),
  line('event_msg', { type: 'task_started', turn_id: T2 }),
  user('two'),
  assistant('a2', 'second answer'),
  'not json',
].join('\n')

const shown = [
  { role: 'user', content: 'one' },
  { role: 'assistant', content: 'working' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'two' },
  { role: 'assistant', content: 'second answer' },
]
const upTo = (count: number) => shown.slice(0, count)

describe('findCodexForkTurn', () => {
  it('forks through the turn an assistant reply ends', () => {
    expect(findCodexForkTurn(rollout, 'a1', upTo(3))).toEqual({ ok: true, turnId: T1 })
    expect(findCodexForkTurn(rollout, 'a2', upTo(5))).toEqual({ ok: true, turnId: T2 })
  })

  it('prefers the turn id Codex stamps on the item itself', () => {
    const stamped = [
      line('event_msg', { type: 'task_started', turn_id: T1 }),
      user('one'),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        id: 'a',
        content: [{ type: 'output_text', text: 'x' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'stamped' },
      }),
    ].join('\n')
    expect(
      findCodexForkTurn(stamped, 'a', [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'x' },
      ]),
    ).toEqual({ ok: true, turnId: 'stamped' })
  })

  it('refuses a message that does not end its turn', () => {
    expect(findCodexForkTurn(rollout, 'a1-interim', upTo(2))).toMatchObject({
      ok: false,
      code: 'native-anchor-mid-turn',
    })
    expect(findCodexForkTurn(rollout, 'u-two', upTo(4))).toMatchObject({ ok: false, code: 'native-anchor-mid-turn' })
  })

  it('refuses when the thread does not hold the whole displayed prefix', () => {
    expect(findCodexForkTurn(rollout, 'a1', upTo(5))).toMatchObject({ ok: false, code: 'native-lineage-incompatible' })
  })

  it('refuses when the thread holds different messages before the anchor', () => {
    const other = [{ role: 'user', content: 'something else' }, ...upTo(3).slice(1)]
    expect(findCodexForkTurn(rollout, 'a1', other)).toMatchObject({ ok: false, code: 'native-lineage-incompatible' })
  })

  it('refuses a missing message or turn id', () => {
    expect(findCodexForkTurn(rollout, 'nope', upTo(1))).toMatchObject({ ok: false, code: 'native-history-missing' })
    expect(
      findCodexForkTurn([user('one'), assistant('a', 'x')].join('\n'), 'a', [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'x' },
      ]),
    ).toMatchObject({ ok: false, code: 'native-turn-missing' })
  })
})

describe('isUnsupportedMethodError', () => {
  it('recognises JSON-RPC method-not-found and the app-server unknown-variant form', () => {
    expect(isUnsupportedMethodError(Object.assign(new Error('x'), { code: -32601 }), 'thread/fork')).toBe(true)
    expect(
      isUnsupportedMethodError(
        Object.assign(new Error('Invalid request: unknown variant `thread/fork`, expected one of ...'), {
          code: -32600,
        }),
        'thread/fork',
      ),
    ).toBe(true)
    expect(isUnsupportedMethodError(new NativeForkUnsupportedError('no fork'), 'session/fork')).toBe(true)
  })

  it('treats any other failure as a real failure', () => {
    expect(
      isUnsupportedMethodError(
        Object.assign(new Error("lastTurnId 'x' was not found in the source thread"), { code: -32600 }),
        'thread/fork',
      ),
    ).toBe(false)
  })
})

describe('pickOpencodeForkSession', () => {
  const segment = { provider: 'opencode', provider_session_id: 'ses_1', provider_instance_id: 'oc', created_at: 1_000 }
  const latest = { role: 'assistant', canonicalIndex: 3, canonicalMessageCount: 4 }

  it('forks the only session when the anchor is the latest reply', () => {
    expect(
      pickOpencodeForkSession({ segments: [segment], instanceId: 'oc', firstMessageAt: 2_000, anchor: latest }),
    ).toEqual({ ok: true, sessionId: 'ses_1' })
  })

  it('keeps the handoff for an earlier anchor, since ACP forks the whole session', () => {
    expect(
      pickOpencodeForkSession({
        segments: [segment],
        instanceId: 'oc',
        firstMessageAt: 2_000,
        anchor: { ...latest, canonicalIndex: 1 },
      }),
    ).toMatchObject({ ok: false, code: 'native-anchor-not-latest' })
  })

  it('keeps the handoff when one session does not hold the whole chat', () => {
    const base = { instanceId: 'oc', firstMessageAt: 2_000, anchor: latest }
    expect(pickOpencodeForkSession({ ...base, segments: [] }).ok).toBe(false)
    expect(
      pickOpencodeForkSession({ ...base, segments: [segment, { ...segment, provider_session_id: 'ses_2' }] }).ok,
    ).toBe(false)
    expect(pickOpencodeForkSession({ ...base, segments: [{ ...segment, provider_instance_id: 'other' }] }).ok).toBe(
      false,
    )
    expect(pickOpencodeForkSession({ ...base, segments: [{ ...segment, created_at: 200_000 }] }).ok).toBe(false)
    expect(
      pickOpencodeForkSession({ ...base, segments: [segment], anchor: { ...latest, role: 'user' } }),
    ).toMatchObject({ ok: false, code: 'native-anchor-mid-turn' })
  })
})
