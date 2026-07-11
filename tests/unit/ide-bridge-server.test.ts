/**
 * BridgeServer routes messages between the main process and sb-bridge
 * extension hosts. Tested with fake sockets - no ws server, no network.
 * Covers: token reject, malformed JSON, hello registration, open routing
 * by folder, selection fan-in, close cleanup.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { BridgeServer, type SelectionMessage } from '../../src/main/ide/bridge-server'

class FakeSocket extends EventEmitter {
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.emit('close')
  }
}

const TOKEN = 'secret-token'

describe('BridgeServer', () => {
  let wss: EventEmitter
  let server: BridgeServer
  let selections: SelectionMessage[]

  function connect(url: string): FakeSocket {
    const socket = new FakeSocket()
    wss.emit('connection', socket, { url })
    return socket
  }

  function connectAndHello(folder: string): FakeSocket {
    const socket = connect(`/?token=${TOKEN}`)
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', folder })))
    return socket
  }

  beforeEach(() => {
    wss = new EventEmitter()
    selections = []
    server = new BridgeServer(wss, TOKEN, { onSelection: (m) => selections.push(m) })
  })

  it('closes connections that present a wrong or missing token', () => {
    const bad = connect('/?token=wrong')
    const missing = connect('/')
    expect(bad.closed).not.toBeNull()
    expect(missing.closed).not.toBeNull()
    // and a hello on a rejected socket registers nothing
    bad.emit('message', Buffer.from(JSON.stringify({ type: 'hello', folder: '/p' })))
    expect(server.openFile('/p', '/p/a.ts')).toBe(false)
  })

  it('registers a folder on hello and routes open messages to it', () => {
    const socket = connectAndHello('/Users/x/proj')
    expect(server.openFile('/Users/x/proj', '/Users/x/proj/src/a.ts', 10, 20)).toBe(true)
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'open',
      path: '/Users/x/proj/src/a.ts',
      line: 10,
      endLine: 20,
    })
  })

  it('returns false when no extension host serves the folder', () => {
    connectAndHello('/Users/x/other')
    expect(server.openFile('/Users/x/proj', '/p/a.ts')).toBe(false)
  })

  it('forwards selection messages to the callback', () => {
    const socket = connectAndHello('/p')
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'selection', path: '/p/a.ts', startLine: 1, endLine: 3, text: 'x' }))
    )
    expect(selections).toEqual([{ type: 'selection', path: '/p/a.ts', startLine: 1, endLine: 3, text: 'x' }])
  })

  it('drops malformed frames without crashing and keeps the socket usable', () => {
    const socket = connectAndHello('/p')
    socket.emit('message', Buffer.from('{nope'))
    socket.emit('message', Buffer.from('{"type":"evil"}'))
    socket.emit('message', Buffer.from('{"type":"selection"}')) // missing fields
    expect(selections).toHaveLength(0)
    expect(server.openFile('/p', '/p/a.ts')).toBe(true)
  })

  it('unregisters the folder when the socket closes', () => {
    const socket = connectAndHello('/p')
    socket.emit('close')
    expect(server.openFile('/p', '/p/a.ts')).toBe(false)
  })

  it('a newer hello for the same folder wins (webview reload reconnects)', () => {
    const stale = connectAndHello('/p')
    const fresh = connectAndHello('/p')
    server.openFile('/p', '/p/a.ts')
    expect(stale.sent).toHaveLength(0)
    expect(fresh.sent).toHaveLength(1)
  })

  it('broadcastConfig sends a config frame to every registered workbench', () => {
    const a = connectAndHello('/p1')
    const b = connectAndHello('/p2')
    const sent = server.broadcastConfig({ 'workbench.colorTheme': 'Default Light Modern' })
    expect(sent).toBe(2)
    expect(JSON.parse(a.sent[0])).toEqual({
      type: 'config',
      settings: { 'workbench.colorTheme': 'Default Light Modern' },
    })
    expect(JSON.parse(b.sent[0])).toEqual(JSON.parse(a.sent[0]))
  })

  it('a stale socket close does not unregister a fresher one for the same folder', () => {
    const stale = connectAndHello('/p')
    connectAndHello('/p')
    stale.emit('close')
    expect(server.openFile('/p', '/p/a.ts')).toBe(true)
  })
})
