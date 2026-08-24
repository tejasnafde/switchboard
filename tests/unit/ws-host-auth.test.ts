/**
 * WsHost connection auth: when constructed with a token, connections must
 * present it as `?token=`; bad/missing tokens are closed with 4001 before any
 * frame is processed. Without a token the open behavior is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { AddressInfo } from 'node:net'
import { WsHost } from '../../src/main/backend/ws-host'
import { currentBackendRequestContext } from '../../src/main/backend/request-context'
import { FilesChannels } from '../../src/shared/ipc-channels'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function boot(token?: string): Promise<{ port: number; host: WsHost }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => wss.close())
    const host = new WsHost(wss, token)
    wss.on('listening', () => resolve({ port: (wss.address() as AddressInfo).port, host }))
  })
}

/**
 * Resolves with how the dial ended. The WS upgrade completes before the
 * server's app-level close(4001) arrives, so 'open' alone proves nothing -
 * send a probe frame: accepted sockets get a res frame back ('open'),
 * rejected ones get the close code.
 */
function dial(url: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false
    const settle = (v: 'open' | number): void => {
      if (settled) return
      settled = true
      ws.close()
      resolve(v)
    }
    ws.on('open', () => ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'probe', args: [] })))
    ws.on('message', () => settle('open'))
    ws.on('close', (code) => settle(code))
    ws.on('error', () => {}) // close event carries the verdict
  })
}

describe('WsHost token auth', () => {
  it('accepts a connection presenting the right token', async () => {
    const { port } = await boot('s3cret')
    expect(await dial(`ws://127.0.0.1:${port}/?token=s3cret`)).toBe('open')
  })

  it('closes 4001 on a missing token', async () => {
    const { port } = await boot('s3cret')
    expect(await dial(`ws://127.0.0.1:${port}/`)).toBe(4001)
  })

  it('closes 4001 on a wrong token', async () => {
    const { port } = await boot('s3cret')
    expect(await dial(`ws://127.0.0.1:${port}/?token=nope`)).toBe(4001)
  })

  it('rejected sockets never reach the handler map', async () => {
    const { port, host } = await boot('s3cret')
    let called = false
    host.handle('ping', () => {
      called = true
      return 'pong'
    })
    await dial(`ws://127.0.0.1:${port}/?token=nope`)
    expect(called).toBe(false)
  })

  it('tokenless host keeps the open trust model', async () => {
    const { port } = await boot()
    expect(await dial(`ws://127.0.0.1:${port}/`)).toBe('open')
  })

  it('propagates authenticated scopes and blocks chat-only launch-config mutation', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    let fileWriteCalled = false
    const host = new WsHost(
      wss,
      undefined,
      {
        redeem: () => ({ ok: false }),
        authenticate: (session) => session === 'phone-session'
          ? { id: 'phone-1', scopes: ['chat'] }
          : null,
      },
      true,
    )
    host.handle('scope', () => currentBackendRequestContext()?.deviceScopes)
    host.handle(FilesChannels.WRITE_FILE, () => {
      fileWriteCalled = true
      return { ok: true }
    })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    const port = (wss.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?auth=frame`)
    cleanups.push(() => {
      ws.close()
      host.dispose()
      wss.close()
    })
    const messages: unknown[] = []
    const waiters: Array<(value: unknown) => void> = []
    ws.on('message', (data) => {
      const value = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(value)
      else messages.push(value)
    })
    const next = (): Promise<unknown> => new Promise((resolve) => {
      const value = messages.shift()
      if (value !== undefined) resolve(value)
      else waiters.push(resolve)
    })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    ws.send(JSON.stringify({ k: 'auth', session: 'phone-session' }))
    expect(await next()).toMatchObject({ k: 'authed', ok: true, scopes: ['chat'] })
    ws.send(JSON.stringify({ k: 'req', id: 1, ch: 'scope', args: [] }))
    expect(await next()).toMatchObject({ k: 'res', id: 1, ok: true, result: ['chat'] })
    ws.send(JSON.stringify({
      k: 'req',
      id: 2,
      ch: FilesChannels.WRITE_FILE,
      args: ['/repo', '.switchboard/launch-config.yaml', 'worktree:\n  setup:\n    command: evil'],
    }))
    expect(await next()).toMatchObject({
      k: 'res',
      id: 2,
      ok: false,
      error: expect.stringMatching(/not permitted/),
    })
    expect(fileWriteCalled).toBe(false)
  })
})
