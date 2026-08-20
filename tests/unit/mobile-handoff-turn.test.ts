import { describe, expect, it, vi } from 'vitest'
import { prepareMobileHandoffTurn } from '../../apps/mobile/src/lib/handoffTurn'

describe('prepareMobileHandoffTurn', () => {
  it('injects bounded visible history when a profile restart left a pending handoff', async () => {
    const client = {
      getPendingHandoff: vi.fn().mockResolvedValue({ from: 'claude-code' }),
      loadSessionById: vi.fn().mockResolvedValue({
        messages: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      }),
    }

    await expect(prepareMobileHandoffTurn(client, 'thread-1', 'continue')).resolves.toEqual({
      pending: true,
      wireMessage: expect.stringContaining('earlier answer'),
    })
    const result = await prepareMobileHandoffTurn(client, 'thread-1', 'continue')
    expect(result.wireMessage).toMatch(/Respond to the latest user message.*\n\ncontinue/s)
  })

  it('leaves ordinary turns untouched without a pending handoff', async () => {
    const client = {
      getPendingHandoff: vi.fn().mockResolvedValue({ from: null }),
      loadSessionById: vi.fn(),
    }

    await expect(prepareMobileHandoffTurn(client, 'thread-1', 'ordinary')).resolves.toEqual({
      pending: false,
      wireMessage: 'ordinary',
    })
    expect(client.loadSessionById).not.toHaveBeenCalled()
  })
})
