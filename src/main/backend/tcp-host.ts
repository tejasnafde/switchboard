/**
 * BackendHost over raw TCP, newline-delimited JSON. IAP hands a phone a RAW TCP
 * stream, so there is no WebSocket to speak; our frames are already JSON and
 * JSON.stringify escapes newlines, so one frame per line needs no RFC6455.
 *
 * With a token set, the first line must be {"k":"auth","token":...} or the
 * socket is destroyed, and emit() never reaches an unauthenticated client.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server, Socket } from 'node:net'
import { BACKEND_CAPABILITIES, encodeFrame, decodeFrame, type WsFrame } from '@shared/ws-protocol'
import {
  isChannelAllowed,
  isFileMutationAllowed,
  isSettingWriteAllowed,
  PHONE_SCOPES,
  type DeviceScope,
} from '@shared/device-auth'
import { AppChannels, FilesChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'
import { hashClientScope, withBackendRequestContext } from './request-context'

const log = createLogger('backend:tcp-host')

/**
 * One frame's ceiling. Generous because a turn can carry image attachments and
 * base64 inflates them by a third. Going over destroys the connection rather
 * than rejecting the frame, so it must sit above any legitimate payload.
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024

function tokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface Client {
  socket: Socket
  buf: string
  authed: boolean
  clientScope: string
}

export class TcpHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  private readonly clients = new Set<Client>()
  private readonly epoch = randomUUID()

  constructor(
    server: Server,
    private readonly token?: string,
    private readonly deviceScopes: readonly DeviceScope[] = PHONE_SCOPES,
  ) {
    server.on('connection', (socket) => {
      socket.setNoDelay(true)
      const client: Client = {
        socket,
        buf: '',
        authed: !this.token,
        clientScope: this.token
          ? hashClientScope('legacy-tcp-token', this.token)
          : hashClientScope('trusted-tcp', 'local-trust-boundary'),
      }
      this.clients.add(client)
      log.info(`client connected (${this.clients.size} total)`)

      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => this.onData(client, chunk))
      socket.on('close', () => {
        this.clients.delete(client)
        log.info(`client disconnected (${this.clients.size} total)`)
      })
      socket.on('error', (err) => log.warn(`socket error: ${err.message}`))
    })
  }

  private onData(client: Client, chunk: string): void {
    client.buf += chunk
    if (client.buf.length > MAX_LINE_BYTES) {
      log.error('frame exceeded max size, dropping client')
      client.socket.destroy()
      return
    }
    for (;;) {
      const nl = client.buf.indexOf('\n')
      if (nl < 0) return
      const line = client.buf.slice(0, nl)
      client.buf = client.buf.slice(nl + 1)
      if (line.trim()) void this.onLine(client, line)
    }
  }

  private async onLine(client: Client, line: string): Promise<void> {
    if (!client.authed) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        log.warn('unparseable auth line, dropping client')
        client.socket.destroy()
        return
      }
      const msg = parsed as { k?: unknown; token?: unknown }
      if (msg.k !== 'auth' || !tokenMatches(this.token as string, msg.token)) {
        log.warn('bad or missing auth token, dropping client')
        client.socket.destroy()
        return
      }
      client.authed = true
      this.write(client, { k: 'res', id: 0, ok: true, result: 'authed' })
      this.writeReady(client)
      return
    }

    const frame = decodeFrame(line)
    if (!frame) {
      log.warn('dropped unparseable frame')
      return
    }
    if ((frame.k === 'req' || frame.k === 'snd') && !isChannelAllowed(this.deviceScopes, frame.ch)) {
      log.warn(`denied ${frame.ch} - outside this device's scopes (${this.deviceScopes.join(',')})`)
      if (frame.k === 'req') {
        this.write(client, { k: 'res', id: frame.id, ok: false, error: `not permitted: ${frame.ch}` })
      }
      return
    }
    if (
      (frame.k === 'req' || frame.k === 'snd')
      && frame.ch === AppChannels.SETTINGS_SET
      && !isSettingWriteAllowed(this.deviceScopes, (frame.args as unknown[] | undefined)?.[0])
    ) {
      log.warn(`denied ${frame.ch} - protected settings key, outside this device's scopes`)
      if (frame.k === 'req') {
        this.write(client, { k: 'res', id: frame.id, ok: false, error: 'not permitted: protected setting' })
      }
      return
    }
    if (
      (frame.k === 'req' || frame.k === 'snd')
      && (frame.ch === FilesChannels.WRITE_FILE || frame.ch === FilesChannels.DELETE_FILE)
      && !isFileMutationAllowed(
        this.deviceScopes,
        (frame.args as unknown[] | undefined)?.[0],
        (frame.args as unknown[] | undefined)?.[1],
      )
    ) {
      log.warn(`denied ${frame.ch} - command-bearing launch config requires terminal scope`)
      if (frame.k === 'req') {
        this.write(client, { k: 'res', id: frame.id, ok: false, error: 'not permitted: protected launch config' })
      }
      return
    }
    if (frame.k === 'req') {
      const handler = this.handlers.get(frame.ch)
      if (!handler) {
        this.write(client, { k: 'res', id: frame.id, ok: false, error: `no handler: ${frame.ch}` })
        return
      }
      try {
        const result = await withBackendRequestContext(
          { clientScope: client.clientScope, transport: 'remote', deviceScopes: this.deviceScopes },
          () => handler(...frame.args),
        )
        this.write(client, { k: 'res', id: frame.id, ok: true, result })
      } catch (err) {
        this.write(client, {
          k: 'res',
          id: frame.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else if (frame.k === 'snd') {
      const fns = this.listeners.get(frame.ch)
      if (fns) for (const fn of fns) {
        withBackendRequestContext(
          { clientScope: client.clientScope, transport: 'remote', deviceScopes: this.deviceScopes },
          () => fn(...frame.args),
        )
      }
    } else if (frame.k === 'hello') {
      this.writeReady(client)
    }
  }

  private writeReady(client: Client): void {
    this.write(client, {
      k: 'ready',
      epoch: this.epoch,
      seq: 0,
      replayed: 0,
      gap: false,
      capabilities: [...BACKEND_CAPABILITIES],
    })
  }

  private write(client: Client, frame: WsFrame): void {
    if (client.socket.destroyed) return
    client.socket.write(encodeFrame(frame) + '\n')
  }

  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }

  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    const fns = this.listeners.get(channel) ?? []
    fns.push(fn as (...args: unknown[]) => void)
    this.listeners.set(channel, fns)
  }

  emit(channel: string, ...args: unknown[]): void {
    if (!isChannelAllowed(this.deviceScopes, channel)) return
    const line = encodeFrame({ k: 'evt', ch: channel, args }) + '\n'
    for (const client of this.clients) {
      // Unauthed sockets must never receive session events.
      if (client.authed && !client.socket.destroyed) client.socket.write(line)
    }
  }

  /**
   * Destroy every connected client socket. Unlike a WebSocket server, a raw
   * `net.Server` exposes no client set of its own, so without this an
   * IAP-tunnelled phone that never sends a FIN would hold the listener's
   * process open through shutdown with nothing tracking it. Call when the
   * listener itself is going down.
   */
  dispose(): void {
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
  }
}
