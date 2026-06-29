/**
 * Standalone headless backend: the same handlers + ProviderRegistry over a
 * WsHost, for running on a VM. Desktop-only handlers are omitted.
 * Env: PORT, SWITCHBOARD_DATA_DIR, SWITCHBOARD_SECRET.
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
