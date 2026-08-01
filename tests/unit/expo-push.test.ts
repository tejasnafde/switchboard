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
  pendingReceiptsFrom,
  readReceipts,
  fetchReceipts,
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
    expect(await sendPush([], MSG)).toEqual({ sent: 0, deadTokens: [], pendingReceipts: [] })
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
    expect(await sendPush(['tok-a', 'tok-b'], MSG)).toEqual({ sent: 2, deadTokens: ['tok-b'], pendingReceipts: [] })
  })

  it('swallows a network failure - a notification must not break the turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(sendPush(['tok-a'], MSG)).resolves.toEqual({ sent: 0, deadTokens: [], pendingReceipts: [] })
  })

  it('swallows a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' }))
    await expect(sendPush(['tok-a'], MSG)).resolves.toEqual({ sent: 0, deadTokens: [], pendingReceipts: [] })
  })
})

/**
 * Tickets and receipts are two different verdicts and only the second is
 * authoritative about delivery. Reading only tickets is why dead tokens were
 * accumulating: `DeviceNotRegistered` almost always arrives on the receipt.
 */
describe('receipts', () => {
  it('collects ticket ids for accepted messages only', () => {
    const body = {
      data: [
        { status: 'ok', id: 'r1' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok', id: 'r3' },
      ],
    }
    expect(pendingReceiptsFrom(['a', 'b', 'c'], body)).toEqual([
      { id: 'r1', token: 'a' },
      { id: 'r3', token: 'c' },
    ])
  })

  it('ignores an accepted ticket with no id, which cannot be looked up', () => {
    expect(pendingReceiptsFrom(['a'], { data: [{ status: 'ok' }] })).toEqual([])
  })

  it('tolerates a malformed body', () => {
    expect(pendingReceiptsFrom(['a'], null)).toEqual([])
    expect(pendingReceiptsFrom(['a'], { data: 'nope' })).toEqual([])
  })

  it('condemns a token whose receipt reports DeviceNotRegistered', () => {
    const pending = [
      { id: 'r1', token: 'a' },
      { id: 'r2', token: 'b' },
    ]
    const body = {
      data: {
        r1: { status: 'ok' },
        r2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    }
    expect(readReceipts(pending, body)).toEqual({ deadTokens: ['b'], resolvedIds: ['r1', 'r2'] })
  })

  it('leaves a token alone for a non-fatal receipt error', () => {
    const pending = [{ id: 'r1', token: 'a' }]
    const body = { data: { r1: { status: 'error', details: { error: 'MessageRateExceeded' } } } }
    // Rate limiting is about us, not the device. Forgetting the token here
    // would silently unregister a working phone.
    expect(readReceipts(pending, body)).toEqual({ deadTokens: [], resolvedIds: ['r1'] })
  })

  it('does not resolve an id the service had no answer for yet', () => {
    // A receipt does not exist until delivery has been attempted. Treating a
    // missing entry as resolved would discard the verdict for good.
    const pending = [
      { id: 'r1', token: 'a' },
      { id: 'r2', token: 'b' },
    ]
    expect(readReceipts(pending, { data: { r1: { status: 'ok' } } })).toEqual({
      deadTokens: [],
      resolvedIds: ['r1'],
    })
  })

  it('swallows a failed receipt lookup and resolves nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchReceipts([{ id: 'r1', token: 'a' }])).resolves.toEqual({
      deadTokens: [],
      resolvedIds: [],
    })
  })
})
