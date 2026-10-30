/**
 * The headless backend's WebSocket credentials, through the host src/server
 * builds: the pairing token a phone scans is a phone credential, the desktop
 * token and the tokenless loopback forward keep every scope.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, type AddressInfo } from 'ws'
import { createHeadlessWsHost } from '../../src/server/ws-credentials'
import { WsTransport } from '../../src/shared/ws-transport'
import { AgentSecretChannels, FilesChannels, TerminalChannels } from '../../src/shared/ipc-channels'

const CANARY = 'sbcanary_finding5_0123456789'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function boot(credentials: { pairingToken?: string; desktopToken?: string }): Promise<{
  port: number
  answers: unknown[][]
}> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => new Promise<void>((res) => wss.close(() => res())))
  const host = createHeadlessWsHost(wss, credentials)
  const answers: unknown[][] = []
  host.handle(AgentSecretChannels.ANSWER, (...args: unknown[]) => {
    answers.push(args)
    return { ok: true }
  })
  host.handle(FilesChannels.LIST_DIR, () => ({ ok: true, entries: [] }))
  host.handle(TerminalChannels.CREATE, () => ({ ok: true }))
  await new Promise<void>((res) => wss.on('listening', () => res()))
  return { port: (wss.address() as AddressInfo).port, answers }
}

/** Connected: a secret call is refused, not queued, before the socket opens. */
async function connect(url: string): Promise<WsTransport> {
  const client = new WsTransport(url)
  cleanups.push(() => client.close())
  await client.invoke(FilesChannels.LIST_DIR, '/', '')
  return client
}

const answer = (client: WsTransport): Promise<unknown> =>
  client.invoke(AgentSecretChannels.ANSWER, 'thread-1', 'card-1', { save: CANARY })

describe('headless backend credentials', () => {
  it('refuses a secret answer from the pairing (phone) token and never runs the handler', async () => {
    const { port, answers } = await boot({ pairingToken: 'phone-token', desktopToken: 'desktop-token' })
    const phone = await connect(`ws://127.0.0.1:${port}/?token=phone-token`)
    await expect(answer(phone)).rejects.toThrow(`not permitted: ${AgentSecretChannels.ANSWER}`)
    for (const ch of [AgentSecretChannels.EXTEND, AgentSecretChannels.DELETE, AgentSecretChannels.LIST]) {
      await expect(phone.invoke(ch, 'thread-1', 'secret-1')).rejects.toThrow(`not permitted: ${ch}`)
    }
    await expect(phone.invoke(TerminalChannels.CREATE, {})).rejects.toThrow('not permitted')
    expect(answers).toEqual([])
  })

  it('keeps the chat surface open to the pairing token', async () => {
    const { port } = await boot({ pairingToken: 'phone-token', desktopToken: 'desktop-token' })
    const phone = await connect(`ws://127.0.0.1:${port}/?token=phone-token`)
    await expect(phone.invoke(FilesChannels.LIST_DIR, '/', '')).resolves.toEqual({ ok: true, entries: [] })
  })

  it('accepts a secret answer from the desktop token', async () => {
    const { port, answers } = await boot({ pairingToken: 'phone-token', desktopToken: 'desktop-token' })
    const desktop = await connect(`ws://127.0.0.1:${port}/?token=desktop-token`)
    await expect(answer(desktop)).resolves.toEqual({ ok: true })
    await expect(desktop.invoke(TerminalChannels.CREATE, {})).resolves.toEqual({ ok: true })
    expect(answers).toHaveLength(1)
  })

  it('accepts a secret answer over the tokenless loopback forward the desktop dials', async () => {
    const { port, answers } = await boot({})
    const desktop = await connect(`ws://127.0.0.1:${port}`)
    await expect(answer(desktop)).resolves.toEqual({ ok: true })
    expect(answers).toHaveLength(1)
  })
})
