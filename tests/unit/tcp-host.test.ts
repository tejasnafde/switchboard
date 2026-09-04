/**
 * TcpHost: newline-delimited JSON BackendHost, the target a phone reaches
 * through Google's IAP relay (which yields a raw TCP stream, not a WebSocket).
 * Covers the auth gate, invoke/send/emit round-trips, and the two framing
 * hazards that matter on a real socket: a frame split across TCP segments and
 * several frames arriving coalesced.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { TcpHost } from '../../src/main/backend/tcp-host'
import { currentBackendRequestContext } from '../../src/main/backend/request-context'
import { TerminalChannels } from '../../src/shared/ipc-channels'
import type { DeviceScope } from '../../src/shared/device-auth'

let server: Server | null = null
let sock: Socket | null = null

afterEach(() => {
  sock?.destroy()
  server?.close()
  sock = null
  server = null
})

async function boot(token?: string, scopes?: readonly DeviceScope[]): Promise<{ host: TcpHost; port: number }> {
  const s = createServer()
  server = s
  const host = new TcpHost(s, token, scopes)
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()))
  return { host, port: (s.address() as AddressInfo).port }
}

/** Collects newline-delimited frames off the socket. */
function reader(socket: Socket): { lines: unknown[]; next: () => Promise<unknown> } {
  const lines: unknown[] = []
  const waiters: Array<(v: unknown) => void> = []
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const parsed = JSON.parse(line)
      const w = waiters.shift()
      if (w) w(parsed)
      else lines.push(parsed)
    }
  })
  return {
    lines,
    next: () =>
      new Promise((res) => {
        const queued = lines.shift()
        if (queued !== undefined) res(queued)
        else waiters.push(res)
      }),
  }
}

async function dial(port: number): Promise<{ socket: Socket; r: ReturnType<typeof reader> }> {
  const socket = connect(port, '127.0.0.1')
  sock = socket
  await new Promise<void>((res) => socket.on('connect', () => res()))
  return { socket, r: reader(socket) }
}

describe('TcpHost auth gate', () => {
  it('rejects a client that does not authenticate first', async () => {
    const { host, port } = await boot('s3cret')
    let called = false
    host.handle('ping', () => {
      called = true
      return 'pong'
    })
    const { socket } = await dial(port)
    socket.write(JSON.stringify({ k: 'req', id: 1, ch: 'ping', args: [] }) + '\n')
    await new Promise<void>((res) => socket.on('close', () => res()))
    expect(called).toBe(false)
  })

  it('rejects a wrong token and accepts the right one', async () => {
    const { port } = await boot('s3cret')
    const { socket } = await dial(port)
    socket.write(JSON.stringify({ k: 'auth', token: 'nope' }) + '\n')
    await new Promise<void>((res) => socket.on('close', () => res()))

    const { host: h2, port: p2 } = await boot('s3cret')
    h2.handle('ping', () => 'pong')
    const { socket: s2, r } = await dial(p2)
    s2.write(JSON.stringify({ k: 'auth', token: 's3cret' }) + '\n')
    expect(await r.next()).toMatchObject({ ok: true, result: 'authed' })
    expect(await r.next()).toMatchObject({
      k: 'ready',
      capabilities: ['durable_turn_origin', 'atomic_user_turn_v1', 'worktree_creation_v1', 'conversation_fork_v1'],
    })
  })

  it('a tokenless host needs no auth frame', async () => {
    const { host, port } = await boot()
    host.handle('ping', () => 'pong')
    const { socket, r } = await dial(port)
    socket.write(JSON.stringify({ k: 'req', id: 7, ch: 'ping', args: [] }) + '\n')
    expect(await r.next()).toMatchObject({ k: 'res', id: 7, ok: true, result: 'pong' })
  })
})

describe('TcpHost framing', () => {
  it('carries the phone scopes into handlers and rejects terminal-scoped channels', async () => {
    const { host, port } = await boot()
    let terminalCalled = false
    host.handle('scope', () => currentBackendRequestContext()?.deviceScopes)
    host.handle('terminal:create', () => {
      terminalCalled = true
      return 'created'
    })
    const { socket, r } = await dial(port)

    socket.write(JSON.stringify({ k: 'req', id: 1, ch: 'scope', args: [] }) + '\n')
    expect(await r.next()).toMatchObject({ id: 1, ok: true, result: ['chat'] })
    socket.write(JSON.stringify({ k: 'req', id: 2, ch: 'terminal:create', args: [] }) + '\n')
    expect(await r.next()).toMatchObject({ id: 2, ok: false, error: expect.stringMatching(/not permitted/) })
    expect(terminalCalled).toBe(false)
  })

  it('round-trips invoke with args and rejects handler errors', async () => {
    const { host, port } = await boot()
    host.handle('add', (a: unknown, b: unknown) => (a as number) + (b as number))
    host.handle('boom', () => {
      throw new Error('nope')
    })
    const { socket, r } = await dial(port)
    socket.write(JSON.stringify({ k: 'req', id: 1, ch: 'add', args: [2, 3] }) + '\n')
    expect(await r.next()).toMatchObject({ id: 1, ok: true, result: 5 })
    socket.write(JSON.stringify({ k: 'req', id: 2, ch: 'boom', args: [] }) + '\n')
    expect(await r.next()).toMatchObject({ id: 2, ok: false, error: 'nope' })
  })

  it('reassembles a frame split across TCP segments', async () => {
    const { host, port } = await boot()
    host.handle('echo', (v: unknown) => v)
    const { socket, r } = await dial(port)
    const line = JSON.stringify({ k: 'req', id: 9, ch: 'echo', args: ['hello'] }) + '\n'
    socket.write(line.slice(0, 12))
    socket.write(line.slice(12, 25))
    socket.write(line.slice(25))
    expect(await r.next()).toMatchObject({ id: 9, ok: true, result: 'hello' })
  })

  it('handles several frames coalesced into one segment', async () => {
    const { host, port } = await boot()
    host.handle('echo', (v: unknown) => v)
    const { socket, r } = await dial(port)
    socket.write(
      JSON.stringify({ k: 'req', id: 1, ch: 'echo', args: ['a'] }) + '\n' +
        JSON.stringify({ k: 'req', id: 2, ch: 'echo', args: ['b'] }) + '\n',
    )
    expect(await r.next()).toMatchObject({ id: 1, result: 'a' })
    expect(await r.next()).toMatchObject({ id: 2, result: 'b' })
  })

  it('a payload containing newlines survives (JSON escapes them)', async () => {
    const { host, port } = await boot()
    host.handle('echo', (v: unknown) => v)
    const { socket, r } = await dial(port)
    const multiline = 'line1\nline2\nline3'
    socket.write(JSON.stringify({ k: 'req', id: 3, ch: 'echo', args: [multiline] }) + '\n')
    expect(await r.next()).toMatchObject({ id: 3, result: multiline })
  })

  it('send reaches a listener and emit pushes to the client', async () => {
    const { host, port } = await boot()
    const got: unknown[] = []
    host.on('provider:client-event', (v: unknown) => got.push(v))
    const { socket, r } = await dial(port)
    socket.write(JSON.stringify({ k: 'snd', ch: 'provider:client-event', args: ['payload'] }) + '\n')
    await new Promise((res) => setTimeout(res, 30))
    expect(got).toEqual(['payload'])

    host.emit('provider:event', { type: 'content', threadId: 't1' })
    expect(await r.next()).toMatchObject({ k: 'evt', ch: 'provider:event' })
  })

  it('emit never reaches an unauthenticated socket', async () => {
    const { host, port } = await boot('s3cret')
    const { r } = await dial(port)
    host.emit('provider:event', { secret: true })
    await new Promise((res) => setTimeout(res, 40))
    expect(r.lines).toHaveLength(0)
  })

  it('filters outbound events through the authenticated device scopes', async () => {
    const { host, port } = await boot(undefined, ['chat'])
    host.handle('probe', () => 'ready')
    const { socket, r } = await dial(port)
    socket.write(JSON.stringify({ k: 'req', id: 1, ch: 'probe', args: [] }) + '\n')
    expect(await r.next()).toMatchObject({ k: 'res', id: 1, ok: true })

    host.emit(TerminalChannels.OUTPUT, 'terminal-1', 'secret output')
    await new Promise((res) => setTimeout(res, 30))
    expect(r.lines).toHaveLength(0)

    host.emit('provider:event', { type: 'content', threadId: 'thread-1' })
    expect(await r.next()).toMatchObject({ k: 'evt', ch: 'provider:event' })
  })
})

describe('TcpHost.dispose', () => {
  it('destroys every connected client, so a listener shutdown is not held open by an IAP-tunnelled phone', async () => {
    // A raw net.Server tracks no client set of its own (unlike WebSocketServer's
    // `.clients`) - without this, a phone that never sends a FIN would keep the
    // process that owns this listener alive through shutdown.
    const { host, port } = await boot()
    const { socket: a } = await dial(port)
    const { socket: b } = await dial(port)
    const aClosed = new Promise<void>((res) => a.on('close', () => res()))
    const bClosed = new Promise<void>((res) => b.on('close', () => res()))

    host.dispose()

    await Promise.all([aClosed, bClosed])
    expect(a.destroyed).toBe(true)
    expect(b.destroyed).toBe(true)
  })
})
