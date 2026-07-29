/**
 * startBridgeHost is the remote half of the workbench integration: it runs
 * inside the headless backend on a VM, accepts the sb-bridge extension's socket
 * and relays intents to the desktop over WsHost.emit.
 *
 * The regression it exists for: on a remote machine cmd+shift+E toggled the IDE
 * ON (the desktop's own document handler saw the key) but never back OFF,
 * because focus was inside the workbench webview and there was no bridge on the
 * remote to forward the intent. These tests pin the relay, not the transport.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { IdeChannels } from '@shared/ipc-channels'

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

/** Stands in for the real ws.WebSocketServer the module constructs. */
class FakeWss extends EventEmitter {
  static instances: FakeWss[] = []
  constructor(public opts: { host: string; port: number }) {
    super()
    FakeWss.instances.push(this)
  }
}

vi.mock('ws', () => ({ WebSocketServer: FakeWss }))

/** Minimal BackendHost: records emits and holds the registered handlers. */
function fakeHost() {
  const emitted: Array<{ channel: string; args: unknown[] }> = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    emitted,
    handlers,
    host: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      on: () => {},
      emit: (channel: string, ...args: unknown[]) => emitted.push({ channel, args }),
    },
  }
}

const TOKEN = 'remote-token'
const FOLDER = '/home/tejas/repo'

let startBridgeHost: typeof import('../../src/main/ide/bridge-host').startBridgeHost

beforeEach(async () => {
  FakeWss.instances = []
  ;({ startBridgeHost } = await import('../../src/main/ide/bridge-host'))
})

function start(): {
  ctx: ReturnType<typeof fakeHost>
  wss: FakeWss
  connectAndHello: (folder?: string) => FakeSocket
} {
  const ctx = fakeHost()
  startBridgeHost({ host: ctx.host, port: 8767, token: TOKEN, userDataDir: '/tmp/sb-ide-data' })
  const wss = FakeWss.instances[0]
  const connectAndHello = (folder = FOLDER): FakeSocket => {
    const socket = new FakeSocket()
    wss.emit('connection', socket, { url: `/?token=${TOKEN}` })
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', folder })))
    return socket
  }
  return { ctx, wss, connectAndHello }
}

describe('startBridgeHost', () => {
  it('listens on loopback only - the extension dials it from the same VM', () => {
    start()
    expect(FakeWss.instances[0].opts).toEqual({ host: '127.0.0.1', port: 8767 })
  })

  it('relays a terminal intent to the desktop so cmd+shift+E can toggle back off', () => {
    const { ctx, connectAndHello } = start()
    const socket = connectAndHello()
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'terminal' })))
    expect(ctx.emitted.map((e) => e.channel)).toContain(IdeChannels.TERMINAL_REQUEST)
  })

  it('relays a data-scientist-mode intent (cmd+shift+J)', () => {
    const { ctx, connectAndHello } = start()
    const socket = connectAndHello()
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'dsmode' })))
    expect(ctx.emitted.map((e) => e.channel)).toContain(IdeChannels.DS_MODE_REQUEST)
  })

  it('relays a selection (cmd+l / cmd+k) with its payload intact', () => {
    const { ctx, connectAndHello } = start()
    const socket = connectAndHello()
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'selection', path: '/a/b.ts', startLine: 3, endLine: 9, text: 'x', intent: 'edit' }),
      ),
    )
    const selection = ctx.emitted.find((e) => e.channel === IdeChannels.SELECTION)
    expect(selection?.args[0]).toMatchObject({ path: '/a/b.ts', startLine: 3, endLine: 9, intent: 'edit' })
  })

  it('rejects a socket presenting the wrong token', () => {
    const { ctx, wss } = start()
    const socket = new FakeSocket()
    wss.emit('connection', socket, { url: '/?token=wrong' })
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'terminal' })))
    expect(socket.closed).not.toBeNull()
    expect(ctx.emitted).toHaveLength(0)
  })

  it('routes an open to the workbench serving that folder, resolving a relative path', async () => {
    const { ctx, connectAndHello } = start()
    const socket = connectAndHello()
    const open = ctx.handlers.get(IdeChannels.OPEN)!
    const res = await open({ folder: FOLDER, path: 'src/a.ts', line: 12 })
    expect(res).toEqual({ ok: true })
    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toEqual({
      type: 'open',
      path: `${FOLDER}/src/a.ts`,
      line: 12,
    })
  })

  it('queues an open for a workbench that has not connected yet, and flushes it on hello', async () => {
    const { ctx, connectAndHello } = start()
    const open = ctx.handlers.get(IdeChannels.OPEN)!
    // Pill clicked while the remote workbench is still booting.
    expect(await open({ folder: FOLDER, path: '/abs/a.ts', line: 4 })).toEqual({ ok: false })

    const socket = connectAndHello()
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'open', path: '/abs/a.ts', line: 4 })
  })

  it('focuses the explorer on hello when nothing is queued', () => {
    const { connectAndHello } = start()
    const socket = connectAndHello()
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'focusExplorer' })
  })

  it('pushes a theme change through a connected workbench rather than writing the file', async () => {
    const { ctx, connectAndHello } = start()
    const socket = connectAndHello()
    expect(await ctx.handlers.get(IdeChannels.SET_THEME)!({ theme: 'dark' })).toEqual({ ok: true })
    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toEqual({
      type: 'config',
      settings: { 'workbench.colorTheme': 'Switchboard Charcoal' },
    })
  })

  it('logs an async bind failure instead of taking the whole backend down', () => {
    // A lingering code-server's old bridge holding 8767 must not stop agents,
    // terminals and git from working. ws surfaces EADDRINUSE on the socket, not
    // as a constructor throw, so an unhandled 'error' would crash the process.
    const { wss } = start()
    expect(() => wss.emit('error', new Error('EADDRINUSE'))).not.toThrow()
  })
})
