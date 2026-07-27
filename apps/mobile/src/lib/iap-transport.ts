/**
 * Transport reaching a work VM's backend through Google Cloud IAP:
 * app -> wss://tunnel.cloudproxy.app (443) -> raw TCP to <vm>:<port> -> TcpHost.
 * Implements the same Transport interface as WsTransport, so screens and stores
 * are unaware of which one they have.
 *
 * Two framings stack, and either can split mid-item, so both are buffered: IAP
 * subprotocol frames outside (see @shared/iap-tunnel), our newline-delimited
 * JSON inside. The relay needs periodic ACKs or it stalls, and
 * `Origin: bot:iap-tunneler` or it accepts the socket then says nothing.
 */
import {
  IapFrameParser,
  chunkForIap,
  encodeIapAck,
  encodeIapData,
  iapConnectUrl,
  IAP_SUBPROTOCOL,
  type IapTarget,
} from '@shared/iap-tunnel'
import { encodeFrame, decodeFrame, type WsFrame } from '@shared/ws-protocol'
import type { Transport } from '@shared/transport'
import { createLogger } from '@shared/logger'

const log = createLogger('iap-transport')

const DEFAULT_TIMEOUT_MS = 30_000
const PROVIDER_TIMEOUT_MS = 200_000
/** ACK once this many unacknowledged bytes have arrived. */
const ACK_THRESHOLD_BYTES = 32 * 1024

export type IapTransportState = 'connected' | 'closed'

interface PendingInvoke {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface IapTransportOptions {
  target: IapTarget
  /** Google OAuth access token with cloud-platform scope. */
  accessToken: string
  /** Shared secret the VM's TcpHost expects (SWITCHBOARD_TOKEN). */
  backendToken?: string
  timeoutMs?: number
}

function stripTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end)
}

export class IapTransport implements Transport {
  private ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, PendingInvoke>()
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly parser = new IapFrameParser()
  /** Lines not yet terminated by '\n' (inner framing). */
  private lineBuf = ''
  /** Frames queued until the tunnel is up and authed. */
  private readonly outbox: string[] = []
  private open = false
  private closed = false
  private bytesReceived = 0
  private bytesAcked = 0
  private readonly timeoutMs: number
  private readonly backendToken?: string

  onStateChange: ((state: IapTransportState) => void) | null = null

  constructor(opts: IapTransportOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.backendToken = opts.backendToken

    const url = iapConnectUrl(opts.target)
    // RN's WebSocket accepts a headers option; Origin is load-bearing.
    // React Native's WebSocket accepts a third options arg (custom headers);
    // lib.dom's signature stops at two, hence the cast.
    const RNWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers: Record<string, string> },
    ) => WebSocket
    this.ws = new RNWebSocket(url, IAP_SUBPROTOCOL, {
      headers: {
        Origin: 'bot:iap-tunneler',
        Authorization: `Bearer ${opts.accessToken}`,
        'User-Agent': 'switchboard-mobile',
      },
    })
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      if (this.closed) return
      log.info('iap tunnel open', `${opts.target.instance}:${opts.target.port}`)
      this.open = true
      // TcpHost wants the auth line first, ahead of anything queued.
      if (this.backendToken) {
        this.sendLine(JSON.stringify({ k: 'auth', token: this.backendToken }))
      }
      for (const line of this.outbox.splice(0)) this.sendLine(line)
      this.onStateChange?.('connected')
    }
    this.ws.onmessage = (ev: MessageEvent) => this.onMessage(ev)
    this.ws.onerror = () => {
      log.warn('iap tunnel error')
      this.die('tunnel error')
    }
    this.ws.onclose = () => this.die('tunnel closed')
  }

  isAlive(): boolean {
    return !this.closed
  }

  private onMessage(ev: MessageEvent): void {
    if (this.closed) return
    const data = ev.data
    if (!(data instanceof ArrayBuffer)) return
    const bytes = new Uint8Array(data)

    for (const frame of this.parser.push(bytes)) {
      switch (frame.kind) {
        case 'connectSuccess':
          log.info('iap session established')
          break
        case 'data':
          this.bytesReceived += frame.payload.length
          this.consume(frame.payload)
          this.maybeAck()
          break
        case 'ack':
        case 'reconnectAck':
          break
        case 'unknown':
          log.error(`unknown iap tag 0x${frame.tag.toString(16)}, closing`)
          this.die('unknown iap frame')
          return
      }
    }
  }

  /** Inner layer: accumulate utf8, split on newline, dispatch whole frames. */
  private consume(payload: Uint8Array): void {
    this.lineBuf += new TextDecoder().decode(payload)
    for (;;) {
      const nl = this.lineBuf.indexOf('\n')
      if (nl < 0) return
      const line = this.lineBuf.slice(0, nl)
      this.lineBuf = this.lineBuf.slice(nl + 1)
      if (!line.trim()) continue
      const frame = decodeFrame(line)
      if (frame) this.dispatch(frame)
    }
  }

  private maybeAck(): void {
    if (this.bytesReceived - this.bytesAcked < ACK_THRESHOLD_BYTES) return
    this.bytesAcked = this.bytesReceived
    this.rawSend(encodeIapAck(this.bytesAcked))
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

  private rawSend(bytes: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1) return
    // RN's WebSocket.send accepts ArrayBuffer for binary frames.
    this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  }

  /** Outer layer: utf8 + chunk to the relay's 16 KB DATA limit. */
  private sendLine(line: string): void {
    const bytes = new TextEncoder().encode(line + '\n')
    for (const chunk of chunkForIap(bytes)) this.rawSend(encodeIapData(chunk))
  }

  private write(frame: Extract<WsFrame, { ch: string }>): boolean {
    if (this.closed) return false
    const line = encodeFrame(frame)
    if (this.open) this.sendLine(line)
    else this.outbox.push(line)
    return true
  }

  private die(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.open = false
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(reason))
    }
    this.pending.clear()
    this.outbox.length = 0
    this.onStateChange?.('closed')
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
      if (!this.write({ k: 'req', id, ch: channel, args: stripTrailingUndefined(args) })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('transport closed'))
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
    this.die('transport closed')
    try {
      this.ws.close()
    } catch (err) {
      log.warn('close() on a dead tunnel', err)
    }
  }
}
