/**
 * BackendHost over a raw TCP socket, newline-delimited JSON.
 *
 * Why this exists alongside WsHost: a phone reaches a work VM through Google's
 * IAP TCP-forwarding relay, which yields a RAW TCP stream to a VM port. Speaking
 * WebSocket inside that stream would mean implementing an RFC6455 client on the
 * phone for no benefit - our wire frames are already JSON, so the WebSocket
 * framing was incidental. One frame per line is enough.
 *
 * Safe because JSON.stringify escapes newlines inside strings, so a literal
 * '\n' only ever appears as a frame delimiter.
 *
 * Auth: when a token is configured the client's FIRST line must be
 * {"k":"auth","token":"..."} or the socket is destroyed. IAP already proves the
 * caller holds a Google identity with tunnel access; the token additionally
 * proves it is this user's Switchboard.
 */
import { timingSafeEqual } from 'node:crypto'
import type { Server, Socket } from 'node:net'
import { encodeFrame, decodeFrame, type WsFrame } from '@shared/ws-protocol'
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'

const log = createLogger('backend:tcp-host')

/** A single frame must not exceed this while buffering, to bound memory. */
const MAX_LINE_BYTES = 8 * 1024 * 1024

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
}

export class TcpHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  private readonly clients = new Set<Client>()

  constructor(
    server: Server,
    private readonly token?: string,
  ) {
    server.on('connection', (socket) => {
      socket.setNoDelay(true)
      const client: Client = { socket, buf: '', authed: !this.token }
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
      return
    }

    const frame = decodeFrame(line)
    if (!frame) {
      log.warn('dropped unparseable frame')
      return
    }
    if (frame.k === 'req') {
      const handler = this.handlers.get(frame.ch)
      if (!handler) {
        this.write(client, { k: 'res', id: frame.id, ok: false, error: `no handler: ${frame.ch}` })
        return
      }
      try {
        const result = await handler(...frame.args)
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
      if (fns) for (const fn of fns) fn(...frame.args)
    }
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
    const line = encodeFrame({ k: 'evt', ch: channel, args }) + '\n'
    for (const client of this.clients) {
      // Unauthed sockets must never receive session events.
      if (client.authed && !client.socket.destroyed) client.socket.write(line)
    }
  }
}
