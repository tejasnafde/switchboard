import { requireOptionalNativeModule } from 'expo-modules-core'
import { Platform } from 'react-native'
import { createLogger } from '@shared/logger'
import { isCertFingerprint } from '@shared/transport-security'
import { CERTIFICATE_CHANGED_CLOSE, type TransportSocket } from '@shared/ws-transport'

const log = createLogger('lib:pinned-websocket')
export const CERTIFICATE_CHANGED_MESSAGE = "This computer's certificate changed. Scan its QR again to pair"
interface NativeEvent {
  id: string
  type: 'open' | 'message' | 'close' | 'error'
  data?: string
  code?: number
  certificateChanged?: boolean
}
interface NativePinnedSocket {
  connect(id: string, url: string, fingerprint: string): void
  send(id: string, text: string): void
  close(id: string): void
  addListener(name: 'socketEvent', listener: (event: NativeEvent) => void): { remove(): void }
}
const native =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativePinnedSocket>('SwitchboardPinnedWebSocket') : null
let nextId = 0

export function pinnedTarget(url: string): { url: string; fingerprint: string } | null {
  if (!native) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
  const fp = parsed.searchParams.get('fp')
  if (fp === null) return null
  const fingerprint = fp.toLowerCase()
  if (!isCertFingerprint(fingerprint)) throw new Error('Invalid certificate fingerprint. Scan the QR again to pair')
  parsed.protocol = 'wss:'
  parsed.searchParams.delete('fp')
  return { url: parsed.toString(), fingerprint }
}

/** Only the text/event subset used by WsTransport. Never falls back to another socket. */
export class PinnedWebSocket implements TransportSocket {
  private readonly id = `pinned-${Date.now()}-${++nextId}`
  private readonly listeners = new Map<string, Set<(event: never) => void>>()
  private readonly subscription: { remove(): void }
  private closed = false
  private open = false

  constructor(url: string, fingerprint: string) {
    if (!native) throw new Error('Pinned WebSocket is unavailable in this binary')
    this.subscription = native.addListener('socketEvent', (event) => {
      if (event.id !== this.id || this.closed) return
      if (event.type === 'open') {
        this.open = true
        this.emit('open', {})
      } else if (event.type === 'message') {
        this.emit('message', { data: event.data })
      } else if (event.type === 'error') {
        log.warn('native socket failed', { certificateChanged: !!event.certificateChanged })
        // Close first: WsTransport treats an error without a close code as retryable.
        this.finish(event.certificateChanged ? CERTIFICATE_CHANGED_CLOSE : 1006)
        this.emit('error', {})
      } else {
        this.finish(event.code ?? 1006)
      }
    })
    native.connect(this.id, url, fingerprint)
  }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void): void {
    let listeners = this.listeners.get(type)
    if (!listeners) this.listeners.set(type, (listeners = new Set()))
    listeners.add(listener)
  }

  private emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }

  send(text: string): void {
    if (!this.open || this.closed) throw new Error('WebSocket is not open')
    native!.send(this.id, text)
  }

  close(): void {
    if (this.closed) return
    native!.close(this.id)
    this.finish(1000)
  }

  private finish(code: number): void {
    if (this.closed) return
    this.closed = true
    this.open = false
    this.subscription.remove()
    this.emit('close', { code })
  }
}
