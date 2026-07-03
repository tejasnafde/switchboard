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
import { registerLspHandlers } from '../main/ipc/lsp'
import { registerKanbanHandlers } from '../main/ipc/kanban'
import { registerProviderInstanceHandlers } from '../main/ipc/providerInstances'
import { registerTerminalHandlers } from '../main/ipc/terminal'
import { registerAgentHandlers } from '../main/ipc/agent'
import { ProviderRegistry } from '../main/provider/provider-registry'
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
const PID_FILE = join(homedir(), '.switchboard-server', 'server.pid')
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
registerLspHandlers(host)
registerKanbanHandlers(host)
registerProviderInstanceHandlers(host)
registerTerminalHandlers(host)
registerAgentHandlers(host)
host.handle(SERVER_VERSION_CHANNEL, () => __SERVER_VERSION__)

const registry = new ProviderRegistry(host)
registry.registerIpcHandlers()

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
    void registry.stopAll().finally(() => wss.close(() => process.exit(0)))
  })
}
