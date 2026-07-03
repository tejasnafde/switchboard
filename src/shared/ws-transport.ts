/**
 * Client Transport over a WebSocket (vs Electron IPC). Uses the global
 * WebSocket so it needs no dependency. Frames before 'open' queue; in-flight
 * invokes reject on close. ponytail: single connection, no reconnect yet.
 */
import { encodeFrame, decodeFrame, type WsFrame } from './ws-protocol'
import type { Transport } from './transport'
import { createLogger } from './logger'

const log = createLogger('ws-transport')

const DEFAULT_TIMEOUT_MS = 30_000
/** provider:* channels can run long (OpenCode cold boot, providerInstances TEST
 *  shelling out to a CLI) - give them a generous timeout instead of the default. */
const PROVIDER_TIMEOUT_MS = 200_000

/** Drop trailing `undefined` args before serializing - JSON.stringify would
 *  otherwise turn them into `null`, diverging from Electron structured-clone
 *  (which drops them, so callee default params still apply). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end)
}

export class WsTransport implements Transport {
  private ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly outbox: string[] = []
  private open = false
  private closed = false

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
      this.closed = true
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('WebSocket closed'))
      }
      this.pending.clear()
      // Drop anything queued before open - the socket is gone, nothing will
      // ever flush this, and holding it would just mask the failure.
      this.outbox.length = 0
    })
  }

  private write(frame: Extract<WsFrame, { ch: string }>): void {
    if (this.closed) {
      log.warn('dropping frame after close', frame.ch)
      return
    }
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
    if (this.closed) return Promise.reject(new Error('transport closed'))
    const id = this.nextId++
    const timeoutMs = channel.startsWith('provider') ? PROVIDER_TIMEOUT_MS : this.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`invoke timed out: ${channel}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.write({ k: 'req', id, ch: channel, args: stripTrailingUndefined(args) })
    })
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ k: 'snd', ch: channel, args: stripTrailingUndefined(args) })
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
