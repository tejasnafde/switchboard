/**
 * A typed secret never goes out over plain ws:// to a host off this computer.
 * The base transport (SWITCHBOARD_BACKEND_URL, through HybridTransport) and a
 * per-machine transport are both WsTransports, so both are tested here.
 */
import { describe, it, expect, vi } from 'vitest'
import { WsTransport, type TransportSocket } from '../../src/shared/ws-transport'
import { HybridTransport } from '../../src/preload/hybrid-transport'
import { AgentSecretChannels } from '../../src/shared/ipc-channels'
import { CLEARTEXT_SECRET_REFUSAL } from '../../src/shared/transport-security'
import type { Transport } from '../../src/shared/transport'

const CANARY = 'sbcanary_finding6_0123456789'

function openTransport(url: string): { transport: WsTransport; sent: string[] } {
  const sent: string[] = []
  const events = new Map<string, (event: never) => void>()
  const socket: TransportSocket = {
    send: (data: string) => {
      sent.push(data)
    },
    close: vi.fn(),
    addEventListener: (type, listener) => {
      events.set(type, listener)
    },
  }
  const transport = new WsTransport(url, 60_000, {}, null, () => socket)
  events.get('open')?.(undefined as never)
  return { transport, sent }
}

const save = (t: Transport): Promise<unknown> =>
  t.invoke(AgentSecretChannels.ANSWER, 'thread-1', 'card-1', { save: CANARY })

const unusedLocal: Transport = {
  invoke: () => Promise.reject(new Error('local')),
  send: () => {},
  on: () => () => {},
}

describe('secret answers over cleartext WebSocket', () => {
  it('refuses a saved value to a remote ws:// base backend before it is serialized', async () => {
    const { transport, sent } = openTransport('ws://vm-host:8765/?token=desktop-token')
    const base = new HybridTransport(unusedLocal, transport)
    await expect(save(base)).rejects.toThrow(CLEARTEXT_SECRET_REFUSAL)
    expect(sent.join('\n')).not.toContain(CANARY)
    transport.close()
  })

  it.each(['ws://10.1.2.3:8765', 'ws://10.0.2.2:8765', 'ws://[fe80::1]:8765'])(
    'refuses a saved value on a per-machine transport to %s',
    async (url) => {
      const { transport, sent } = openTransport(url)
      await expect(save(transport)).rejects.toThrow(CLEARTEXT_SECRET_REFUSAL)
      expect(sent.join('\n')).not.toContain(CANARY)
      transport.close()
    },
  )

  it('still sends a decline to a remote ws:// backend', () => {
    const { transport, sent } = openTransport('ws://vm-host:8765')
    void transport.invoke(AgentSecretChannels.ANSWER, 'thread-1', 'card-1', { decline: true })
    expect(sent.some((f) => f.includes(AgentSecretChannels.ANSWER))).toBe(true)
    transport.close()
  })

  it.each([
    'ws://127.0.0.1:54321',
    'ws://127.4.5.6:8765',
    'ws://localhost:8765',
    'ws://[::1]:8765',
    'wss://vm-host:8765/?fp=00',
  ])('sends a saved value over %s', (url) => {
    const { transport, sent } = openTransport(url)
    void save(transport)
    expect(sent.some((f) => f.includes(CANARY))).toBe(true)
    transport.close()
  })
})
