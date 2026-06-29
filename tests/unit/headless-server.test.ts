/**
 * Integration proof for the headless backend: a real WsHost serving the real
 * registerFilesHandlers over a real ws server, driven by a real WsTransport —
 * the exact path src/server/index.ts uses, end to end, with no Electron and no
 * native modules. (DB/PTY-backed handlers need node-ABI natives and are covered
 * by the bundle build + unit tests instead.)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, type AddressInfo } from 'ws'
import { WsHost } from '../../src/main/backend/ws-host'
import { registerFilesHandlers } from '../../src/main/ipc/files'
import { WsTransport } from '../../src/shared/ws-transport'
import { FilesChannels } from '../../src/shared/ipc-channels'

let wss: WebSocketServer | null = null
let client: WsTransport | null = null

afterEach(async () => {
  client?.close()
  client = null
  await new Promise<void>((res) => (wss ? wss.close(() => res()) : res()))
  wss = null
})

describe('headless backend (WsHost + real handlers over WebSocket)', () => {
  it('serves files:list-dir over the wire', async () => {
    wss = new WebSocketServer({ port: 0 })
    const host = new WsHost(wss)
    registerFilesHandlers(host)
    await new Promise<void>((res) => wss!.on('listening', () => res()))
    const { port } = wss.address() as AddressInfo

    client = new WsTransport(`ws://localhost:${port}`)
    const res = await client.invoke<{ ok: boolean; entries?: Array<{ name: string }> }>(
      FilesChannels.LIST_DIR,
      process.cwd(),
      '',
    )
    expect(res.ok).toBe(true)
    expect(res.entries?.some((e) => e.name === 'package.json')).toBe(true)
  })

  it('propagates a handler-level error frame to the client', async () => {
    wss = new WebSocketServer({ port: 0 })
    new WsHost(wss) // no handlers registered
    await new Promise<void>((res) => wss!.on('listening', () => res()))
    const { port } = wss.address() as AddressInfo

    client = new WsTransport(`ws://localhost:${port}`)
    await expect(client.invoke(FilesChannels.LIST_DIR, process.cwd(), '')).rejects.toThrow('no handler')
  })
})
