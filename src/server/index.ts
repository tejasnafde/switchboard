/**
 * Standalone headless backend: the same handlers + ProviderRegistry over a
 * WsHost, for running on a VM. Desktop-only handlers are omitted.
 * Env: PORT, SWITCHBOARD_DATA_DIR, SWITCHBOARD_SECRET.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { WsHost } from '../main/backend/ws-host'
import { registerAppHandlers } from '../main/ipc/app'
import { registerFilesHandlers } from '../main/ipc/files'
import { registerGitHandlers } from '../main/ipc/git'
import { registerKanbanHandlers } from '../main/ipc/kanban'
import { registerProviderInstanceHandlers } from '../main/ipc/providerInstances'
import { registerTerminalHandlers } from '../main/ipc/terminal'
import { registerAgentHandlers } from '../main/ipc/agent'
import { ProviderRegistry } from '../main/provider/provider-registry'
import { disposeUsageProbes } from '../main/provider/usage'
import { startBridgeHost } from '../main/ide/bridge-host'
import { createMainLogger as createLogger } from '../main/logger'

// esbuild `define` in scripts/build-server.mjs stamps this with the app
// version at bundle time so a live server can report what it's running.
declare const __SERVER_VERSION__: string

// Duplicated in src/main/machines/connectDeps.ts (that file can't import this
// one - it would boot a second WebSocketServer as a side effect). Keep the
// two literals in sync.
const SERVER_VERSION_CHANNEL = 'server:version'

const log = createLogger('server')

// Same dir as the uploaded bundle. A lingering process from an ungraceful
// tunnel drop can hold the port; connectDeps.ts REMOTE_COMMAND kills whatever
// pid is recorded here before launching a fresh server.
/** Matches provisionCommands.REMOTE_SERVER_DIR, which is the shell form of this
 *  path and so cannot be imported here. */
const SERVER_HOME = join(homedir(), '.switchboard-server')
const PID_FILE = join(SERVER_HOME, 'server.pid')
try {
  writeFileSync(PID_FILE, String(process.pid))
} catch (err) {
  log.warn('failed to write pid file', err)
}

const port = Number(process.env.PORT ?? 8765)
const bindHost = process.env.HOST ?? '127.0.0.1'
const wss = new WebSocketServer({ port, host: bindHost })
const host = new WsHost(wss)

registerAppHandlers(host)
registerFilesHandlers(host)
registerGitHandlers(host)
registerKanbanHandlers(host)
registerProviderInstanceHandlers(host)
registerTerminalHandlers(host)
registerAgentHandlers(host)
host.handle(SERVER_VERSION_CHANNEL, () => __SERVER_VERSION__)

const registry = new ProviderRegistry(host)
registry.registerIpcHandlers()

// The workbench bridge, when the ssh bootstrap minted a token for us (see
// machines/connectDeps.ts REMOTE_COMMAND). Absent env = this server was started
// by hand without a code-server alongside it, so there is nothing to bridge.
// The port range is validated here rather than defended inside startBridgeHost:
// `ws` throws synchronously on an out-of-range port, which would take the whole
// backend down at module load.
const bridgePort = Number(process.env.SB_BRIDGE_PORT)
const bridgeToken = process.env.SB_BRIDGE_TOKEN
if (Number.isInteger(bridgePort) && bridgePort > 1024 && bridgePort < 65536 && bridgeToken) {
  startBridgeHost({ host, port: bridgePort, token: bridgeToken, userDataDir: join(SERVER_HOME, 'ide-data') })
} else {
  log.info('no usable SB_BRIDGE_PORT/SB_BRIDGE_TOKEN - workbench bridge disabled')
}

wss.on('listening', () => log.info(`switchboard backend listening on ${bindHost}:${port} (v${__SERVER_VERSION__})`))
wss.on('error', (err) => log.error('server error', err))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} - shutting down`)
    try {
      // Only remove the pidfile if it still points at us - a takeover may have
      // already replaced it with a newer server's pid we must not clobber.
      if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE)
    } catch (err) {
      log.warn('failed to remove pid file', err)
    }
    // process.exit skips the probe's own `finally`, so kill any survivor here.
    disposeUsageProbes()
    void registry.stopAll().finally(() => wss.close(() => process.exit(0)))
  })
}
