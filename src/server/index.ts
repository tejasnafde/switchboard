/**
 * Standalone headless backend. Boots the same handler set + ProviderRegistry
 * the Electron main process runs, but over a WsHost (WebSocket) instead of
 * Electron IPC — so it can run on a remote VM. Desktop-only handlers
 * (native dialogs, window vibrancy) are deliberately omitted.
 *
 *   PORT                — listen port (default 8765)
 *   SWITCHBOARD_DATA_DIR — DB / app-support root (default ~/.switchboard)
 *   SWITCHBOARD_SECRET   — passphrase for env-mode provider credentials
 *
 * Run: npm run build:server && npm run server
 */
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

const log = createLogger('server')

const port = Number(process.env.PORT ?? 8765)
const wss = new WebSocketServer({ port })
const host = new WsHost(wss)

registerAppHandlers(host)
registerFilesHandlers(host)
registerGitHandlers(host)
registerLspHandlers(host)
registerKanbanHandlers(host)
registerProviderInstanceHandlers(host)
registerTerminalHandlers(host)
registerAgentHandlers(host)

const registry = new ProviderRegistry(host)
registry.registerIpcHandlers()

wss.on('listening', () => log.info(`switchboard backend listening on :${port}`))
wss.on('error', (err) => log.error('server error', err))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} — shutting down`)
    void registry.stopAll().finally(() => wss.close(() => process.exit(0)))
  })
}
