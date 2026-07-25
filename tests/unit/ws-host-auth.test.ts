/**
 * WsHost connection auth: when constructed with a token, connections must
 * present it as `?token=`; bad/missing tokens are closed with 4001 before any
 * frame is processed. Without a token the open behavior is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { AddressInfo } from 'node:net'
import { WsHost } from '../../src/main/backend/ws-host'

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
})
