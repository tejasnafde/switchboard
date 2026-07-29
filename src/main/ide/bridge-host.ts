/**
 * Boots the sb-bridge socket for the headless backend on a VM.
 *
 * Why a separate entry point from ipc/ide.ts: that module owns the local
 * workbench LIFECYCLE (binary download, CodeServerManager, idle shutdown), none
 * of which a remote has - the ssh bootstrap in machines/connectDeps.ts spawns
 * code-server and hands both processes a shared SB_BRIDGE_TOKEN. The wire
 * behaviour they DO share lives in bridge-channels.ts, so there is one
 * implementation of it.
 *
 * The intents need no tunnel of their own: they ride WsHost.emit over the
 * backend socket the desktop already holds, and TransportRouter fans the event
 * in, so the renderer's existing handlers fire either way.
 *
 * Electron-free by construction: this is bundled into out/server/index.cjs.
 */
import { WebSocketServer } from 'ws'
import { join } from 'node:path'
import type { BackendHost } from '../backend/host'
import { BridgeServer } from './bridge-server'
import { wireBridgeChannels } from './bridge-channels'
import { patchWorkbenchSettings } from './settings'
import { createMainLogger } from '../logger'

const log = createMainLogger('ide:bridge-host')

export interface BridgeHostOptions {
  host: BackendHost
  port: number
  token: string
  /** code-server's --user-data-dir on this machine. */
  userDataDir: string
}

export function startBridgeHost(opts: BridgeHostOptions): BridgeServer {
  const { host, port, token, userDataDir } = opts
  const settingsPath = (): string => join(userDataDir, 'User', 'settings.json')

  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  // ws reports a bind failure (EADDRINUSE from a lingering code-server's old
  // bridge) asynchronously, so this is the only place it can surface. Logged,
  // not thrown: agents, terminals and git are this backend's real job and must
  // not go down with a workbench that cannot phone home.
  wss.on('error', (err) => log.error('bridge socket error', err))
  wss.on('listening', () => log.info(`bridge listening on 127.0.0.1:${port}`))

  let bridge: BridgeServer | null = null
  const callbacks = wireBridgeChannels(host, { getBridge: () => bridge, settingsPath, log })
  bridge = new BridgeServer(wss, token, callbacks)

  // First-run defaults, same as the local boot() does. Backfills keys added in
  // later app versions too, which the install-time seed in provisionSetup.ts
  // cannot: it writes once, when code-server is first downloaded.
  void patchWorkbenchSettings(settingsPath(), {}, log)

  return bridge
}
