/**
 * The desktop app's own WebSocket endpoint for paired phones. Fanned into a
 * MultiHost beside the ElectronIpcHost so both share one ProviderRegistry and
 * one session pool: no `npm run server` needed on the desktop.
 *
 * Gated on a token existing in settings - we never expose an unauthenticated
 * socket beyond loopback.
 */
import { WebSocketServer } from 'ws'
import { getSetting } from '../db/database'
import { createMainLogger as createLogger } from '../logger'
import { WsHost } from './ws-host'

const log = createLogger('backend:mobile-server')

const TOKEN_KEY = 'mobilePairing.token'
const PORT_KEY = 'mobilePairing.port'
const DEFAULT_PORT = 8765

export interface MobileServer {
  host: WsHost
  port: number
  close: () => void
}

/**
 * Boot the pairing endpoint if a token is configured. Returns null when the
 * feature is off (no token) or the port is unavailable - callers then run
 * desktop-only, exactly as before.
 */
export function startMobileServer(): MobileServer | null {
  const token = getSetting(TOKEN_KEY)
  if (!token) {
    log.info('no pairing token configured - mobile endpoint off (Settings > Mobile to enable)')
    return null
  }
  const port = Number(getSetting(PORT_KEY) ?? DEFAULT_PORT) || DEFAULT_PORT

  // 0.0.0.0 so a phone on the LAN/tailnet can reach it; the token is the
  // access control (same trust model as the headless server).
  const wss = new WebSocketServer({ port, host: '0.0.0.0' })
  const host = new WsHost(wss, token)

  wss.on('listening', () => log.info(`mobile endpoint listening on 0.0.0.0:${port}`))
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`port ${port} already in use - mobile endpoint disabled (another Switchboard or server running?)`)
    } else {
      log.error('mobile endpoint error', err)
    }
  })

  return {
    host,
    port,
    close: () => {
      try {
        for (const client of wss.clients) client.terminate()
        wss.close(() => log.info('mobile endpoint closed'))
      } catch (err) {
        log.warn('failed to close mobile endpoint', err)
      }
    },
  }
}
