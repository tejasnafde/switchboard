/**
 * Expo push wire shaping and response reading.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildRequests,
  chunk,
  deadTokensFrom,
  sendPush,
  ANDROID_CHANNEL_ID,
  MAX_BATCH,
} from '../../src/main/push/expo-push'
import type { PushMessage } from '../../src/shared/push-policy'

const MSG: PushMessage = {
  title: 'Fix the parser',
  body: 'Turn finished',
  data: { threadId: 't1', kind: 'done' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildRequests', () => {
  it('shapes one request per token, with an Android channel', () => {
    const [req] = buildRequests(['ExponentPushToken[a]'], MSG)
    expect(req).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'Fix the parser',
      body: 'Turn finished',
      data: { threadId: 't1', kind: 'done' },
      sound: 'default',
      priority: 'high',
      channelId: ANDROID_CHANNEL_ID,
    })
  })

  it('returns nothing for no tokens', () => {
    expect(buildRequests([], MSG)).toEqual([])
  })
})

describe('chunk', () => {
  it('splits at the documented batch limit', () => {
    const batches = chunk(Array.from({ length: MAX_BATCH * 2 + 5 }, (_, i) => i))
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(MAX_BATCH)
    expect(batches[2]).toHaveLength(5)
  })

  it('handles an empty list', () => {
    expect(chunk([])).toEqual([])
  })
})

describe('deadTokensFrom', () => {
  const tokens = ['tok-a', 'tok-b', 'tok-c']

  it('picks out DeviceNotRegistered by position', () => {
    const body = {
      data: [
        { status: 'ok' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok' },
      ],
    }
    expect(deadTokensFrom(tokens, body)).toEqual(['tok-b'])
  })

  it('ignores other errors, which are transient rather than fatal', () => {
    const body = {
      data: [{ status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }],
    }
    expect(deadTokensFrom(tokens, body)).toEqual([])
  })

  it('survives a response that is not the documented shape', () => {
    expect(deadTokensFrom(tokens, null)).toEqual([])
    expect(deadTokensFrom(tokens, {})).toEqual([])
    expect(deadTokensFrom(tokens, { data: 'nope' })).toEqual([])
    expect(deadTokensFrom(tokens, { data: [null] })).toEqual([])
  })
})

describe('sendPush', () => {
  it('does not call the network with no tokens', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await sendPush([], MSG)).toEqual({ sent: 0, deadTokens: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports dead tokens so the caller can forget them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }],
        }),
      }),
    )
    expect(await sendPush(['tok-a', 'tok-b'], MSG)).toEqual({ sent: 2, deadTokens: ['tok-b'] })
  })

  it('swallows a network failure - a notification must not break the turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(sendPush(['tok-a'], MSG)).resolves.toEqual({ sent: 0, deadTokens: [] })
  })

  it('swallows a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' }))
    await expect(sendPush(['tok-a'], MSG)).resolves.toEqual({ sent: 0, deadTokens: [] })
  })
})
