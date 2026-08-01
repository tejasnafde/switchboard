/**
 * The desktop app's own WebSocket endpoint for paired phones. Fanned into a
 * MultiHost beside the ElectronIpcHost so both share one ProviderRegistry and
 * one session pool: no `npm run server` needed on the desktop.
 *
 * A BackendHost whose inner WsHost can be (re)started at runtime: generating a
 * token in Settings > Mobile serves it IMMEDIATELY, instead of showing a QR
 * that points at a dead port until the next app restart (the trap the first
 * version shipped). handle()/on() registrations are recorded and replayed onto
 * each new inner host.
 *
 * Gated on a token existing in settings - we never expose an unauthenticated
 * socket beyond loopback.
 */
import { WebSocketServer } from 'ws'
import type { MobilePairingStatus } from '@shared/types'
import { getSetting } from '../db/database'
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'
import { WsHost } from './ws-host'

const log = createLogger('backend:mobile-server')

const TOKEN_KEY = 'mobilePairing.token'
const PORT_KEY = 'mobilePairing.port'
const DEFAULT_PORT = 8765

/** Shared with the renderer so Settings can render it. */
export type MobileEndpointStatus = MobilePairingStatus

export class MobileEndpoint implements BackendHost {
  /** Registrations recorded for replay onto each (re)started inner host. */
  /** Token the live listener was built with, to detect a real config change. */
  private activeToken: string | null = null
  private readonly handlerRegs: Array<[string, (...args: unknown[]) => unknown]> = []
  private readonly listenerRegs: Array<[string, (...args: unknown[]) => void]> = []
  private inner: WsHost | null = null
  private wss: WebSocketServer | null = null
  private state: MobileEndpointStatus = { listening: false, port: null, reason: 'not started' }

  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlerRegs.push([channel, fn as (...args: unknown[]) => unknown])
    this.inner?.handle(channel, fn)
  }

  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    this.listenerRegs.push([channel, fn as (...args: unknown[]) => void])
    this.inner?.on(channel, fn)
  }

  emit(channel: string, ...args: unknown[]): void {
    this.inner?.emit(channel, ...args)
  }

  status(): MobileEndpointStatus {
    return this.state
  }

  /**
   * Start or restart the listener from the CURRENT settings. Safe to call any
   * time (Settings save, app start).
   *
   * A restart TERMINATES every connected phone, so it must only happen when
   * something actually changed. The Settings tab re-applies on every edit to
   * host, port or token, and typing in one of those fields was kicking a
   * connected phone off once per keystroke - it reconnected, got killed by the
   * next apply, and sat on "connecting" forever.
   */
  apply(): MobileEndpointStatus {
    const desiredToken = getSetting(TOKEN_KEY)
    const desiredPort = Number(getSetting(PORT_KEY) ?? DEFAULT_PORT) || DEFAULT_PORT
    if (
      this.wss !== null &&
      this.state.listening &&
      this.activeToken === desiredToken &&
      this.state.port === desiredPort
    ) {
      return this.state
    }

    this.close()

    const token = getSetting(TOKEN_KEY)
    if (!token) {
      log.info('no pairing token configured - mobile endpoint off (Settings > Mobile to enable)')
      this.state = { listening: false, port: null, reason: 'no token configured' }
      return this.state
    }
    const port = Number(getSetting(PORT_KEY) ?? DEFAULT_PORT) || DEFAULT_PORT

    // 0.0.0.0 so a phone on the LAN/tailnet can reach it; the token is the
    // access control (same trust model as the headless server).
    const wss = new WebSocketServer({ port, host: '0.0.0.0' })
    const inner = new WsHost(wss, token)
    for (const [ch, fn] of this.handlerRegs) inner.handle(ch, fn)
    for (const [ch, fn] of this.listenerRegs) inner.on(ch, fn)

    wss.on('listening', () => {
      log.info(`mobile endpoint listening on 0.0.0.0:${port}`)
      this.state = { listening: true, port, reason: null }
    })
    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`port ${port} already in use - mobile endpoint off (another Switchboard or npm run server?)`)
        this.state = { listening: false, port, reason: `port ${port} is already in use` }
      } else {
        log.error('mobile endpoint error', err)
        this.state = { listening: false, port, reason: err.message }
      }
      this.inner = null
      this.wss = null
    })

    this.wss = wss
    this.inner = inner
    this.activeToken = token
    // Optimistic until the 'listening'/'error' event lands - callers polling
    // status() right after apply() see the port they asked for.
    this.state = { listening: true, port, reason: null }
    return this.state
  }

  close(): void {
    const wss = this.wss
    if (!wss) return
    this.wss = null
    this.inner = null
    this.activeToken = null
    this.state = { listening: false, port: null, reason: 'stopped' }
    try {
      for (const client of wss.clients) client.terminate()
      wss.close(() => log.info('mobile endpoint closed'))
    } catch (err) {
      log.warn('failed to close mobile endpoint', err)
    }
  }
}
