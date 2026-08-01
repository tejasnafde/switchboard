/**
 * The desktop's own WebSocket endpoint for paired phones, fanned into a
 * MultiHost beside the ElectronIpcHost so both share one session pool.
 *
 * The inner WsHost restarts at runtime so a token saved in Settings serves
 * immediately, rather than a QR pointing at a dead port until the next launch;
 * registrations are replayed onto each new inner host. No token, no listener.
 */
import { WebSocketServer } from 'ws'
import type { MobilePairingStatus } from '@shared/types'
import { getSetting } from '../db/database'
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'
import { MAX_FRAME_BYTES, WsHost } from './ws-host'
import { authenticateSession, redeemPairingCode, setRevocationListener } from './device-sessions'
import { PHONE_SCOPES } from '@shared/device-auth'

const log = createLogger('backend:mobile-server')

const ENABLED_KEY = 'mobilePairing.enabled'
const TOKEN_KEY = 'mobilePairing.token'
const PORT_KEY = 'mobilePairing.port'
const DEFAULT_PORT = 8765

/** Shared with the renderer so Settings can render it. */
export type MobileEndpointStatus = MobilePairingStatus

export class MobileEndpoint implements BackendHost {
  /** Token the live listener was built with, to detect a real config change. */
  private activeToken: string | null = null
  /** Whether the endpoint was last applied in the enabled state. */
  private activeEnabled = false
  /** Registrations recorded for replay onto each (re)started inner host. */
  private readonly handlerRegs: Array<[string, (...args: unknown[]) => unknown]> = []
  private readonly listenerRegs: Array<[string, (...args: unknown[]) => void]> = []
  private inner: WsHost | null = null
  private wss: WebSocketServer | null = null
  private state: MobileEndpointStatus = { listening: false, port: null, reason: 'not started' }

  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    // Last-wins on the inner host already; keep the replay list in step.
    const handler = fn as (...args: unknown[]) => unknown
    const existing = this.handlerRegs.findIndex(([ch]) => ch === channel)
    if (existing >= 0) this.handlerRegs.splice(existing, 1)
    this.handlerRegs.push([channel, handler])
    this.inner?.handle(channel, fn)
  }

  /** Last registration per channel wins, matching ElectronIpcHost. Reopening a
   *  window re-runs every registerX against the SAME endpoint, so appending ran
   *  each `snd` handler once per reopen: doubled keystrokes, double kills. */
  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    const listener = fn as (...args: unknown[]) => void
    const existing = this.listenerRegs.findIndex(([ch]) => ch === channel)
    if (existing >= 0) this.listenerRegs.splice(existing, 1)
    this.listenerRegs.push([channel, listener])
    this.inner?.replaceListener(channel, listener)
  }

  emit(channel: string, ...args: unknown[]): void {
    this.inner?.emit(channel, ...args)
  }

  status(): MobileEndpointStatus {
    return this.state
  }

  /**
   * Start or restart the listener from current settings; safe to call any time.
   * A restart terminates every connected phone, so it only happens when the
   * token or port actually changed - Settings re-applies on each keystroke, and
   * restarting per keystroke left phones stuck reconnecting.
   */
  apply(): MobileEndpointStatus {
    const desiredToken = getSetting(TOKEN_KEY)
    const enabled = getSetting(ENABLED_KEY) === 'true'
    const desiredPort = Number(getSetting(PORT_KEY) ?? DEFAULT_PORT) || DEFAULT_PORT
    if (
      this.wss !== null &&
      this.state.listening &&
      this.activeToken === desiredToken &&
      this.activeEnabled === enabled &&
      this.state.port === desiredPort
    ) {
      return this.state
    }

    this.close()

    const token = desiredToken
    // Device sessions are the current credential, so a shared token is no
    // longer what turns the endpoint on. `enabled` is, and a listener with
    // neither is simply off rather than open.
    if (!token && !enabled) {
      log.info('mobile endpoint off (Settings > Mobile to enable)')
      this.state = { listening: false, port: null, reason: 'not enabled' }
      return this.state
    }
    const port = desiredPort

    // 0.0.0.0 so a phone on the LAN/tailnet can reach it; the token is the
    // access control (same trust model as the headless server).
    //
    // maxPayload caps a single frame. `ws` defaults to 100 MB, which on a
    // listener bound to every interface is an easy way for one connection to
    // pin memory. Nothing legitimate approaches this: the largest frames are
    // pasted images, which the chat path already bounds well below it.
    const wss = new WebSocketServer({ port, host: '0.0.0.0', maxPayload: MAX_FRAME_BYTES })
    // The phone gets a device session scoped to chat only: the app has no
    // terminal UI at all, so granting it PTY spawn would mean a stolen
    // credential runs commands rather than merely reads conversations.
    const inner = new WsHost(
      wss,
      token ?? undefined,
      {
        redeem: (pairing, label) => redeemPairingCode(pairing, label, [...PHONE_SCOPES]),
        authenticate: (session) => {
          const found = authenticateSession(session)
          return found ? { id: found.id, scopes: found.scopes } : null
        },
      },
      // Bound to 0.0.0.0, so a connection must present a credential even when
      // no shared token is configured. The default (trust everything) is only
      // correct for loopback and the ssh tunnel.
      true,
      // Static, unrevocable and readable from the settings table, so it gets a
      // phone's scopes: no shell, no pairing administration.
      PHONE_SCOPES,
    )
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
      // Or its heartbeat keeps sweeping an orphaned client set.
      this.inner?.dispose()
      this.inner = null
      this.wss = null
    })

    // A revoke must reach the sockets this endpoint is holding open, or the
    // revoked device keeps working until it next reconnects.
    setRevocationListener((sessionId) => inner.disconnectSession(sessionId))

    this.wss = wss
    this.inner = inner
    this.activeToken = token
    this.activeEnabled = enabled
    // Optimistic until the 'listening'/'error' event lands - callers polling
    // status() right after apply() see the port they asked for.
    this.state = { listening: true, port, reason: null }
    return this.state
  }

  close(): void {
    const wss = this.wss
    if (!wss) return
    this.wss = null
    setRevocationListener(null)
    // Or the heartbeat outlives the endpoint.
    this.inner?.dispose()
    this.inner = null
    this.activeToken = null
    this.activeEnabled = false
    this.state = { listening: false, port: null, reason: 'stopped' }
    try {
      for (const client of wss.clients) client.terminate()
      wss.close(() => log.info('mobile endpoint closed'))
    } catch (err) {
      log.warn('failed to close mobile endpoint', err)
    }
  }
}
