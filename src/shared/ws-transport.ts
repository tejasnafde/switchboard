/**
 * Client Transport over a WebSocket (vs Electron IPC). Uses the global
 * WebSocket so it needs no dependency. Frames before 'open' queue; in-flight
 * invokes reject on close. An unexpected close re-dials the same URL with
 * capped exponential backoff (tunnel blips heal in place - subscriptions and
 * queued frames survive); a deliberate close() or an exhausted reconnect
 * budget closes the transport for good.
 */
import { encodeFrame, decodeFrame, type WsFrame } from './ws-protocol'
import type { Transport } from './transport'
import { createLogger } from './logger'

const log = createLogger('ws-transport')

const DEFAULT_TIMEOUT_MS = 30_000
/** provider:* channels can run long (OpenCode cold boot, providerInstances TEST
 *  shelling out to a CLI) - give them a generous timeout instead of the default. */
const PROVIDER_TIMEOUT_MS = 200_000

/** Re-dial backoff: 500ms doubling to a 5s cap, give up after ~60s total. */
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 5_000
const RECONNECT_BUDGET_MS = 60_000
/** Frames queued while disconnected (pre-open or mid-reconnect) beyond this
 *  bound are rejected/dropped instead of piling up unbounded. */
const MAX_QUEUED_FRAMES = 100

export interface WsReconnectOptions {
  baseMs?: number
  capMs?: number
  budgetMs?: number
}

interface PendingInvoke {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** True once the frame actually went over a socket - a socket close loses
   *  its response for good. Queued invokes stay pending across a re-dial. */
  sent: boolean
}

interface QueuedFrame {
  encoded: string
  /** Set for invoke frames so a flush can mark their pending entry as sent. */
  id?: number
}

/** Drop trailing `undefined` args before serializing - JSON.stringify would
 *  otherwise turn them into `null`, diverging from Electron structured-clone
 *  (which drops them, so callee default params still apply). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end)
}

export class WsTransport implements Transport {
  private ws!: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, PendingInvoke>()
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly outbox: QueuedFrame[] = []
  private open = false
  /** Terminal: deliberate close() or exhausted reconnect budget. Never unset. */
  private closed = false
  private reconnecting = false
  private reconnectAttempt = 0
  private reconnectStartedAt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reconnectBaseMs: number
  private readonly reconnectCapMs: number
  private readonly reconnectBudgetMs: number

  constructor(
    readonly url: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    reconnect: WsReconnectOptions = {},
  ) {
    this.reconnectBaseMs = reconnect.baseMs ?? RECONNECT_BASE_MS
    this.reconnectCapMs = reconnect.capMs ?? RECONNECT_CAP_MS
    this.reconnectBudgetMs = reconnect.budgetMs ?? RECONNECT_BUDGET_MS
    this.dial()
  }

  /** True until a deliberate close() or the reconnect budget runs out - a
   *  transport mid-reconnect is still alive (its subscriptions will survive). */
  isAlive(): boolean {
    return !this.closed
  }

  private dial(): void {
    const sock = new WebSocket(this.url)
    this.ws = sock
    // Every handler guards on `sock === this.ws` so a superseded socket's late
    // events (a slow close from an abandoned dial) can't corrupt current state.
    sock.addEventListener('open', () => {
      if (sock !== this.ws || this.closed) return
      this.open = true
      if (this.reconnecting) {
        log.info('reconnected', this.url)
        this.reconnecting = false
        this.reconnectAttempt = 0
      }
      for (const frame of this.outbox.splice(0)) {
        sock.send(frame.encoded)
        if (frame.id !== undefined) {
          const entry = this.pending.get(frame.id)
          if (entry) entry.sent = true
        }
      }
    })
    sock.addEventListener('message', (ev: MessageEvent) => {
      if (sock !== this.ws) return
      const frame = decodeFrame(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (frame) this.dispatch(frame)
    })
    sock.addEventListener('close', () => {
      if (sock !== this.ws || this.closed) return
      this.open = false
      // In-flight invokes are genuinely lost - their responses died with the
      // socket. Queued (unsent) ones stay pending and flush after the re-dial.
      for (const [id, entry] of this.pending) {
        if (!entry.sent) continue
        clearTimeout(entry.timer)
        entry.reject(new Error('WebSocket closed'))
        this.pending.delete(id)
      }
      this.scheduleRedial()
    })
  }

  private scheduleRedial(): void {
    if (!this.reconnecting) {
      this.reconnecting = true
      this.reconnectStartedAt = Date.now()
      log.warn('socket closed unexpectedly, reconnecting', this.url)
    }
    if (Date.now() - this.reconnectStartedAt >= this.reconnectBudgetMs) {
      log.error(`reconnect budget (${this.reconnectBudgetMs}ms) exhausted, closing for good`, this.url)
      this.shutdown()
      return
    }
    this.reconnectAttempt++
    const delay = Math.min(this.reconnectBaseMs * 2 ** (this.reconnectAttempt - 1), this.reconnectCapMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      this.dial()
    }, delay)
  }

  /** Terminal teardown: reject everything outstanding and stop re-dialing. */
  private shutdown(): void {
    this.closed = true
    this.open = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('transport closed'))
    }
    this.pending.clear()
    this.outbox.length = 0
  }

  /** Queues (or sends) a frame. Returns false when the transport is closed or
   *  the disconnected-queue bound is hit - callers surface that as they fit. */
  private write(frame: Extract<WsFrame, { ch: string }>, id?: number): boolean {
    if (this.closed) {
      log.warn('dropping frame after close', frame.ch)
      return false
    }
    const encoded = encodeFrame(frame)
    if (this.open) {
      this.ws.send(encoded)
      if (id !== undefined) {
        const entry = this.pending.get(id)
        if (entry) entry.sent = true
      }
      return true
    }
    if (this.outbox.length >= MAX_QUEUED_FRAMES) {
      log.warn('disconnected-queue bound hit, dropping frame', frame.ch)
      return false
    }
    this.outbox.push({ encoded, id })
    return true
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sent: false })
      if (!this.write({ k: 'req', id, ch: channel, args: stripTrailingUndefined(args) }, id)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(this.closed ? 'transport closed' : `transport queue full: ${channel}`))
      }
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
    if (this.closed) return
    this.shutdown()
    try {
      this.ws.close()
    } catch (err) {
      log.warn('close() on an already-dead socket', err)
    }
  }
}
