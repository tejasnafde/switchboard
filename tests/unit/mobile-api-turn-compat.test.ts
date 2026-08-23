import { describe, expect, it, vi } from 'vitest'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { Transport } from '../../src/shared/transport'
import type { UserTurnSubmissionV1 } from '../../src/shared/provider-events'
import { SwitchboardClient } from '../../apps/mobile/src/lib/api'

const envelope: UserTurnSubmissionV1 = {
  version: 1,
  threadId: 'thread',
  origin: 'origin-1',
  providerText: 'handoff history\n\ncontinue',
  displayBody: 'continue',
  images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
  runtimeMode: 'sandbox',
  autoTitleText: 'continue',
}

function transport(invoke: Transport['invoke']): Transport {
  return { invoke, send: vi.fn(), on: vi.fn(() => () => undefined) }
}

describe('mobile atomic turn wire compatibility', () => {
  it('uses the typed envelope when the backend supports it', async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: 'accepted',
      accepted: true,
      duplicate: false,
      state: 'completed',
      acceptedAt: 1,
    })
    const client = new SwitchboardClient(transport(invoke))

    await expect(client.submitTurn(envelope)).resolves.toMatchObject({ status: 'accepted' })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(ProviderChannels.SUBMIT_USER_TURN, envelope)
  })

  it('falls back to the old positional call only for a missing typed handler', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('no handler: provider:submit-user-turn'))
      .mockResolvedValueOnce(undefined)
    const client = new SwitchboardClient(transport(invoke))

    await expect(client.submitTurn(envelope)).resolves.toBeUndefined()
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      ProviderChannels.SEND_TURN,
      envelope.threadId,
      envelope.providerText,
      envelope.runtimeMode,
      envelope.images,
      envelope.origin,
    )
  })

  it('does not downgrade after an ambiguous transport failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('WebSocket closed'))
    const client = new SwitchboardClient(transport(invoke))

    await expect(client.submitTurn(envelope)).rejects.toThrow('WebSocket closed')
    expect(invoke).toHaveBeenCalledOnce()
  })
})
