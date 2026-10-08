/** WsHost compresses large frames for clients that offer permessage-deflate. */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WsHost, wsServerOptions } from '../../src/main/backend/ws-host'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

// A history window: repetitive JSON, like the real one.
const history = Array.from({ length: 200 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  content: `Reply ${i}: the test suite passed and the build is green. `.repeat(20),
  timestamp: 1_770_000_000_000 + i,
}))

function boot(): Promise<number> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer(wsServerOptions(0, '127.0.0.1'))
    cleanups.push(() => wss.close())
    const host = new WsHost(wss)
    host.handle('history', () => history)
    wss.on('listening', () => resolve((wss.address() as AddressInfo).port))
  })
}

/** The history over a socket, and the bytes the socket read for it. */
function fetchHistory(port: number, perMessageDeflate: boolean): Promise<{ extensions: string; bytes: number; messages: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate })
    cleanups.push(() => ws.close())
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'history', args: [] })))
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data))
      if (frame.k !== 'res') return
      const socket = (ws as unknown as { _socket: { bytesRead: number } })._socket
      resolve({ extensions: ws.extensions, bytes: socket.bytesRead, messages: frame.result })
    })
  })
}

describe('WsHost permessage-deflate', () => {
  it('sends a history window compressed to a client that offers it', async () => {
    const port = await boot()
    const raw = Buffer.byteLength(JSON.stringify({ k: 'res', id: 1, ok: true, result: history }))
    const plain = await fetchHistory(port, false)
    const deflated = await fetchHistory(port, true)
    expect(plain.extensions).toBe('')
    expect(plain.bytes).toBeGreaterThan(raw)
    expect(deflated.extensions).toContain('permessage-deflate')
    expect(deflated.bytes).toBeLessThan(raw / 4)
    expect(deflated.messages).toEqual(plain.messages)
  })

  it("answers OkHttp's offer with parameters OkHttp accepts", async () => {
    const port = await boot()
    // OkHttp offers a bare permessage-deflate and fails the socket on a
    // response that names client_max_window_bits.
    const accepted = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
          'Sec-WebSocket-Extensions': 'permessage-deflate',
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(String(res.headers['sec-websocket-extensions']))
      })
      req.on('error', reject)
      req.end()
    })
    expect(accepted).toBe('permessage-deflate; server_no_context_takeover; client_no_context_takeover')
  })
})
