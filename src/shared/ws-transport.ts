/**
 * Client side of the remote boundary: a Transport that speaks ws-protocol over
 * a WebSocket instead of Electron IPC. Uses the platform-global WebSocket
 * (browser in the renderer, undici in Node 24+) so it needs no dependency.
 *
 * ponytail: single connection, no reconnect/backoff yet — add when a dropped
 * VM link is a real scenario (Phase 2). Outgoing frames before 'open' are
 * queued; in-flight invokes reject on socket close.
 */
import { encodeFrame, decodeFrame, type WsFrame } from './ws-protocol'
import type { Transport } from './transport'

const DEFAULT_TIMEOUT_MS = 30_000

export class WsTransport implements Transport {
  private ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly outbox: string[] = []
  private open = false

  constructor(url: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.ws = new WebSocket(url)
    this.ws.addEventListener('open', () => {
      this.open = true
      for (const frame of this.outbox.splice(0)) this.ws.send(frame)
    })
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      const frame = decodeFrame(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (frame) this.dispatch(frame)
    })
    this.ws.addEventListener('close', () => {
      this.open = false
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('WebSocket closed'))
      }
      this.pending.clear()
    })
  }

  private write(frame: WsFrame): void {
    const encoded = encodeFrame(frame)
    if (this.open) this.ws.send(encoded)
    else this.outbox.push(encoded)
  }

  private dispatch(frame: WsFrame): void {
    if (frame.k === 'res') {
      const entry = this.pending.get(frame.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(frame.id)
      if (frame.ok) entry.resolve(frame.result)
      else entry.reject(new Error(frame.error))
    } else if (frame.k === 'evt') {
      const set = this.listeners.get(frame.ch)
      if (set) for (const fn of set) fn(...frame.args)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`invoke timed out: ${channel}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.write({ k: 'req', id, ch: channel, args })
    })
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ k: 'snd', ch: channel, args })
  }

  on<A extends unknown[] = unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    const fn = handler as (...args: unknown[]) => void
    set.add(fn)
    return () => set!.delete(fn)
  }

  close(): void {
    this.ws.close()
  }
}
