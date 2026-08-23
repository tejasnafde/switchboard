import { describe, expect, it, vi } from 'vitest'
import {
  submitQueuedTurn,
  type QueuedTurnDeliveryPort,
} from '../../apps/mobile/src/lib/outboxDelivery'
import type { QueuedMessage } from '../../apps/mobile/src/lib/outboxModel'

const image = { url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }

function queued(): QueuedMessage {
  return {
    connectionId: 'mac',
    threadId: 'thread',
    messageId: 'origin-1',
    text: 'continue',
    images: [image],
    runtimeMode: 'sandbox',
    createdAt: 1,
    attempts: 0,
  }
}

function port(result: unknown): QueuedTurnDeliveryPort {
  return {
    prepare: vi.fn().mockResolvedValue({
      pending: true,
      wireMessage: 'handoff history\n\ncontinue',
    }),
    persist: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(result),
  }
}

describe('mobile queued turn delivery', () => {
  it('persists the exact prepared payload before the provider call', async () => {
    const delivery = port({ accepted: false, duplicate: true, state: 'pending' })
    const result = await submitQueuedTurn(queued(), delivery)

    expect(result.disposition).toBe('pending')
    expect(result.message).toMatchObject({
      providerText: 'handoff history\n\ncontinue',
      pendingHandoff: true,
      images: [image],
    })
    expect(delivery.persist).toHaveBeenCalledWith(result.message)
    expect(delivery.send).toHaveBeenCalledWith(result.message)
    expect((delivery.persist as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((delivery.send as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
  })

  it('retains an ambiguous result instead of reporting acceptance', async () => {
    const result = await submitQueuedTurn(
      queued(),
      port({ accepted: false, duplicate: true, state: 'ambiguous' }),
    )

    expect(result.disposition).toBe('ambiguous')
    expect(result.message.images).toEqual([image])
  })

  it('reuses the frozen provider payload without reading changed handoff state', async () => {
    const firstPort = port({ accepted: false, duplicate: true, state: 'ambiguous' })
    const first = await submitQueuedTurn(queued(), firstPort)
    const retryPort = port({ accepted: true, duplicate: true, state: 'completed' })

    const retry = await submitQueuedTurn(first.message, retryPort)

    expect(retry.disposition).toBe('accepted')
    expect(retryPort.prepare).not.toHaveBeenCalled()
    expect(retryPort.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'origin-1',
      providerText: 'handoff history\n\ncontinue',
    }))
  })

  it('preserves positional compatibility with an older backend response', async () => {
    await expect(submitQueuedTurn(queued(), port(undefined))).resolves.toMatchObject({
      disposition: 'accepted',
    })
  })

  it('returns a typed definite rejection without dropping its recoverable payload', async () => {
    const result = await submitQueuedTurn(queued(), port({
      status: 'rejected',
      accepted: false,
      duplicate: false,
      state: 'rejected',
      retryable: false,
      reason: 'Images exceed the 3 MiB synchronization limit',
    }))

    expect(result).toMatchObject({
      disposition: 'rejected',
      retryable: false,
      reason: 'Images exceed the 3 MiB synchronization limit',
      message: { images: [image] },
    })
  })
})
