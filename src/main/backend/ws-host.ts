/**
 * Server side of the remote boundary: a BackendHost that serves the same
 * registerXHandlers / ProviderRegistry code over ws-protocol instead of
 * Electron IPC. server.js constructs one around a WebSocketServer; the same
 * handlers that run in-process under ElectronIpcHost run here unchanged.
 *
 * ponytail: emit broadcasts to every connected client (one renderer expected;
 * extra clients are harmless). Per-client routing lands if multi-window remote
 * becomes real.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import { encodeFrame, decodeFrame, type WsFrame } from '@shared/ws-protocol'
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'

const log = createLogger('backend:ws-host')

export class WsHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  private readonly clients = new Set<WebSocket>()

  constructor(private readonly wss: WebSocketServer) {
    this.wss.on('connection', (socket) => {
      this.clients.add(socket)
      log.info(`client connected (${this.clients.size} total)`)
      socket.on('message', (data) => this.onMessage(socket, data.toString()))
      socket.on('close', () => {
        this.clients.delete(socket)
        log.info(`client disconnected (${this.clients.size} total)`)
      })
      socket.on('error', (err) => log.warn(`socket error: ${err.message}`))
    })
  }

  private async onMessage(socket: WebSocket, data: string): Promise<void> {
    const frame = decodeFrame(data)
    if (!frame) {
      log.warn('dropped unparseable frame')
      return
    }
    if (frame.k === 'req') {
      const handler = this.handlers.get(frame.ch)
      if (!handler) {
        this.reply(socket, { k: 'res', id: frame.id, ok: false, error: `no handler: ${frame.ch}` })
        return
      }
      try {
        const result = await handler(...frame.args)
        this.reply(socket, { k: 'res', id: frame.id, ok: true, result })
      } catch (err) {
        this.reply(socket, { k: 'res', id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    } else if (frame.k === 'snd') {
      const fns = this.listeners.get(frame.ch)
      if (fns) for (const fn of fns) fn(...frame.args)
    }
  }

  private reply(socket: WebSocket, frame: WsFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame))
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
    const encoded = encodeFrame({ k: 'evt', ch: channel, args })
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) socket.send(encoded)
    }
  }
}
