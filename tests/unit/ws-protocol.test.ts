/**
 * decodeFrame is the trust boundary for a socket that, on the mobile endpoint,
 * listens on 0.0.0.0. It used to check only the `k` discriminant and then cast,
 * so a malformed frame reached a handler as `handler(...undefined)` and threw
 * deep inside application code instead of being rejected at the edge.
 */
import { describe, it, expect } from 'vitest'
import { BACKEND_CAPABILITIES, decodeFrame, encodeFrame, isReplayableEventChannel } from '../../src/shared/ws-protocol'

describe('backend capabilities', () => {
  it('advertises atomic user turns without removing durable origins', () => {
    expect(BACKEND_CAPABILITIES).toEqual(expect.arrayContaining([
      'durable_turn_origin',
      'atomic_user_turn_v1',
      'worktree_creation_v1',
      'conversation_fork_v1',
    ]))
  })
})

describe('decodeFrame', () => {
  it('round-trips every frame kind', () => {
    const frames = [
      { k: 'req' as const, id: 1, ch: 'a', args: [1, 'x'] },
      { k: 'res' as const, id: 1, ok: true as const, result: { y: 2 } },
      { k: 'res' as const, id: 1, ok: false as const, error: 'boom' },
      { k: 'snd' as const, ch: 'a', args: [] },
      { k: 'evt' as const, ch: 'a', args: [1], seq: 7 },
      { k: 'hello' as const, since: 4, epoch: 'e1' },
      { k: 'ready' as const, epoch: 'e1', seq: 9, replayed: 2, gap: false, capabilities: ['durable_turn_origin'] },
      { k: 'ping' as const, t: 123 },
      { k: 'pong' as const, t: 123 },
    ]
    for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
  })

  it('rejects malformed JSON and non-objects', () => {
    expect(decodeFrame('not json')).toBeNull()
    expect(decodeFrame('null')).toBeNull()
    expect(decodeFrame('42')).toBeNull()
    expect(decodeFrame('"a string"')).toBeNull()
    // An array has a `k` of undefined but would previously survive the cast.
    expect(decodeFrame('[]')).toBeNull()
  })

  it('rejects an unknown frame kind', () => {
    expect(decodeFrame(JSON.stringify({ k: 'nope' }))).toBeNull()
  })

  it('rejects a req missing its id, channel, or args', () => {
    expect(decodeFrame(JSON.stringify({ k: 'req', ch: 'a', args: [] }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ k: 'req', id: 1, args: [] }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ k: 'req', id: 1, ch: 'a' }))).toBeNull()
    // args must be an array, or the host would spread a non-iterable.
    expect(decodeFrame(JSON.stringify({ k: 'req', id: 1, ch: 'a', args: 'x' }))).toBeNull()
  })

  it('rejects a res whose ok flag is not a boolean, and a failure with no message', () => {
    expect(decodeFrame(JSON.stringify({ k: 'res', id: 1 }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ k: 'res', id: 1, ok: 'yes' }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ k: 'res', id: 1, ok: false }))).toBeNull()
  })

  it('accepts an evt without a sequence, which is how non-replayable channels ship', () => {
    expect(decodeFrame(JSON.stringify({ k: 'evt', ch: 'terminal:data', args: ['x'] }))).toEqual({
      k: 'evt',
      ch: 'terminal:data',
      args: ['x'],
      seq: undefined,
    })
  })

  it('tolerates a hello with no cursor, which is what a first-ever connect sends', () => {
    expect(decodeFrame(JSON.stringify({ k: 'hello' }))).toEqual({ k: 'hello', since: undefined, epoch: undefined })
  })

  it('rejects a ready missing any of its fields, so a partial handshake cannot look complete', () => {
    expect(decodeFrame(JSON.stringify({ k: 'ready', epoch: 'e', seq: 1, replayed: 0 }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ k: 'ready', epoch: 'e', seq: 1, gap: false }))).toBeNull()
  })

  it('accepts old ready frames and preserves only string capabilities when advertised', () => {
    expect(decodeFrame(JSON.stringify({ k: 'ready', epoch: 'e', seq: 1, replayed: 0, gap: false }))).toEqual({
      k: 'ready', epoch: 'e', seq: 1, replayed: 0, gap: false, capabilities: undefined,
    })
    expect(decodeFrame(JSON.stringify({
      k: 'ready', epoch: 'e', seq: 1, replayed: 0, gap: false,
      capabilities: ['durable_turn_origin'],
    }))).toMatchObject({ capabilities: ['durable_turn_origin'] })
    expect(decodeFrame(JSON.stringify({
      k: 'ready', epoch: 'e', seq: 1, replayed: 0, gap: false,
      capabilities: ['durable_turn_origin', 7],
    }))).toBeNull()
  })

  it('rejects a heartbeat with no timestamp', () => {
    expect(decodeFrame(JSON.stringify({ k: 'ping' }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ k: 'pong', t: 'soon' }))).toBeNull()
  })
})

describe('isReplayableEventChannel', () => {
  it('excludes terminal output, which is high-volume and re-seeded on reattach', () => {
    // The SERVER-to-client names. `terminal:data` is the client-to-server
    // keystroke channel and travels as `snd`, so listing it excluded nothing
    // while pty output filled the buffer and evicted provider events.
    expect(isReplayableEventChannel('terminal:output')).toBe(false)
    expect(isReplayableEventChannel('terminal:exit')).toBe(false)
  })

  it('includes provider events, which cannot be recovered any other way', () => {
    expect(isReplayableEventChannel('provider:event')).toBe(true)
  })
})
