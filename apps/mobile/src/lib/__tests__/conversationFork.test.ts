import * as Crypto from 'expo-crypto'
import { forgetMobileForkRequest, mobileForkRequest } from '../conversationFork'

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  randomUUID: jest.fn()
    .mockReturnValueOnce('request-1')
    .mockReturnValueOnce('request-2'),
  digestStringAsync: jest.fn(async () => 'a'.repeat(64)),
}))

describe('mobile conversation fork request', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reuses one request id across retries and anchors the complete message', async () => {
    const message = {
      id: 'message-1', role: 'user' as const, content: '', timestamp: 10,
      images: [{ url: 'data:image/png;base64,AAAA', name: 'screen.png' }],
    }
    const first = await mobileForkRequest({
      connectionId: 'machine', sourceConversationId: 'source', message,
      withWorktree: true, requestedAt: 20,
    })
    const retry = await mobileForkRequest({
      connectionId: 'machine', sourceConversationId: 'source', message,
      withWorktree: true, requestedAt: 30,
    })

    expect(first.requestId).toBe('request-1')
    expect(retry.requestId).toBe(first.requestId)
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(first.anchor).toEqual({
      messageId: 'message-1', role: 'user', timestamp: 10, contentDigest: 'a'.repeat(64),
    })
    expect(first.checkout).toEqual({ kind: 'new-worktree', basePolicy: 'source-head' })

    await forgetMobileForkRequest({
      connectionId: 'machine', sourceConversationId: 'source', messageId: message.id,
      withWorktree: true,
    })
    const independentFork = await mobileForkRequest({
      connectionId: 'machine', sourceConversationId: 'source', message,
      withWorktree: true, requestedAt: 40,
    })
    expect(independentFork.requestId).toBe('request-2')
  })
})
