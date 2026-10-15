import { describe, it, expect, vi } from 'vitest'
import { WsTransport, CERTIFICATE_CHANGED_CLOSE, type TransportSocket } from '../../src/shared/ws-transport'

describe('WsTransport socket factory', () => {
  it('stops permanently on a certificate mismatch and rejects queued work', async () => {
    const events = new Map<string, (event: never) => void>()
    const socket: TransportSocket = {
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type, listener) => {
        events.set(type, listener)
      },
    }
    const factory = vi.fn(() => socket)
    const transport = new WsTransport('wss://mac', undefined, {}, null, factory)
    const pending = transport.invoke('echo')
    const rejected = expect(pending).rejects.toThrow()
    events.get('close')!({ code: CERTIFICATE_CHANGED_CLOSE } as never)
    expect(transport.isAlive()).toBe(false)
    expect(transport.certificateChanged).toBe(true)
    expect(transport.authRejected).toBe(false)
    expect(transport.lastCloseReason).toBe('blocked')
    transport.forceReconnect()
    expect(factory).toHaveBeenCalledTimes(1)
    await rejected
    transport.close()
  })
})
