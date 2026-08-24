import { describe, expect, it, vi } from 'vitest'
import type { BackendHost } from '../../src/main/backend/host'
import { registerAppHandlers } from '../../src/main/ipc/app'
import { AppChannels } from '../../src/shared/ipc-channels'
import type { ForkConversationRequest } from '../../src/shared/conversation-fork'

class FakeHost implements BackendHost {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, handler: (...args: never[]) => unknown): void {
    this.handlers.set(channel, handler as (...args: unknown[]) => unknown)
  }
  emit(): void {}
}

function request(): ForkConversationRequest {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    sourceConversationId: 'source-remote',
    machineId: 'remote-a',
    anchor: {
      messageId: 'message-1', role: 'user', timestamp: 1, contentDigest: 'a'.repeat(64),
    },
    checkout: { kind: 'shared-checkout' },
    provenance: { surface: 'desktop', requestedAt: 1 },
  }
}

describe('conversation fork IPC', () => {
  it('passes the versioned request to the backend coordinator and exposes query-by-request', async () => {
    const host = new FakeHost()
    const completed = { kind: 'completed', result: { requestId: 'request-1' } } as const
    const createOrGet = vi.fn(async () => completed)
    const get = vi.fn(() => completed)
    registerAppHandlers(host, { conversationFork: { createOrGet, get } as never })

    await expect(host.handlers.get(AppChannels.FORK_CONVERSATION)!(request())).resolves.toBe(completed)
    expect(createOrGet).toHaveBeenCalledWith(request())
    expect(host.handlers.get(AppChannels.GET_CONVERSATION_FORK)!({
      machineId: 'remote-a', requestId: 'request-1', sourceConversationId: 'source-remote',
    })).toBe(completed)
    expect(get).toHaveBeenCalledWith('remote-a', 'request-1')
  })

  it('fails a legacy positional request closed instead of executing it locally', async () => {
    const host = new FakeHost()
    const createOrGet = vi.fn()
    registerAppHandlers(host, { conversationFork: { createOrGet, get: vi.fn() } as never })

    await expect(host.handlers.get(AppChannels.FORK_CONVERSATION)!({
      sourceConversationId: 'source-remote', upToIndex: 4,
    })).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'upgrade-required', retryable: false },
    })
    expect(createOrGet).not.toHaveBeenCalled()
  })
})
