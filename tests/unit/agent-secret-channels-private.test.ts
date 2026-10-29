/**
 * The secret answer channels carry the value, so nothing may time, log, queue
 * or let a phone call them: the perf wrapper skips them, a disconnected
 * WsTransport refuses them instead of holding the value in its queue, and
 * device auth gives them to the admin scope only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
const { perfSpan } = vi.hoisted(() => ({ perfSpan: vi.fn() }))
vi.mock('../../src/main/perf', () => ({ perfSpan }))
import { timeBackendHandler } from '../../src/main/backend/perf-handler'
import { WsTransport } from '../../src/shared/ws-transport'
import { AgentSecretChannels, carriesSecretArgs } from '../../src/shared/ipc-channels'
import { FULL_SCOPES, PHONE_SCOPES, isChannelAllowed } from '../../src/shared/device-auth'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'
import { AGENT_SECRET_REQUEST_CAPABILITY } from '../../src/shared/agent-secret-request'

const VALUE = 'sb-test-not-a-secret'
const CHANNELS = Object.values(AgentSecretChannels)

let transport: WsTransport | null = null
afterEach(() => {
  transport?.close()
  transport = null
  vi.clearAllMocks()
})

describe('agent secret channels', () => {
  it('are all marked as carrying a secret, and other channels are not', () => {
    for (const channel of CHANNELS) expect(carriesSecretArgs(channel)).toBe(true)
    expect(carriesSecretArgs('provider:respond-to-request')).toBe(false)
    expect(carriesSecretArgs('settings:get')).toBe(false)
  })

  it('are never wrapped in a perf span', () => {
    const handler = (..._args: unknown[]) => ({ ok: true })
    for (const channel of CHANNELS) {
      expect(timeBackendHandler(channel, handler)).toBe(handler)
      handler('chat', 'sbsec_1', { save: VALUE })
    }
    expect(perfSpan).not.toHaveBeenCalled()
  })

  it('are refused by a disconnected transport rather than queued', async () => {
    transport = new WsTransport('ws://127.0.0.1:1')
    await expect(transport.invoke(AgentSecretChannels.ANSWER, 'chat', 'sbsec_1', { save: VALUE })).rejects.toThrow(
      /Not connected/,
    )
    const queued = transport.invoke('provider:list-sessions')
    queued.catch(() => {})
    expect((transport as unknown as { outbox: Array<{ encoded: string }> }).outbox.map((f) => f.encoded)).toEqual([
      expect.stringContaining('provider:list-sessions'),
    ])
  })

  it('need the admin scope, so a phone credential is refused', () => {
    for (const channel of CHANNELS) {
      expect(isChannelAllowed(FULL_SCOPES, channel)).toBe(true)
      expect(isChannelAllowed(PHONE_SCOPES, channel)).toBe(false)
      expect(isChannelAllowed(['chat', 'pr-write'], channel)).toBe(false)
      expect(isChannelAllowed(['chat', 'terminal'], channel)).toBe(false)
    }
  })

  it('are advertised by the backend capability', () => {
    expect(BACKEND_CAPABILITIES).toContain(AGENT_SECRET_REQUEST_CAPABILITY)
  })
})
