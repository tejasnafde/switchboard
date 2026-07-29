/**
 * Standalone headless backend: the same handlers + ProviderRegistry over a
 * WsHost, for running on a VM. Desktop-only handlers are omitted.
 * Env: PORT, HOST, SWITCHBOARD_DATA_DIR, SWITCHBOARD_SECRET (env-blob
 * passphrase), SWITCHBOARD_TOKEN (WS connection auth - required when binding
 * beyond loopback, e.g. HOST=0.0.0.0 for LAN/tailnet mobile clients).
 */
import { homedir, networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { WebSocketServer } from 'ws'
import { WsHost } from '../main/backend/ws-host'
import { TcpHost } from '../main/backend/tcp-host'
import { MultiHost } from '../main/backend/multi-host'
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
  // The dir exists on a provisioned VM (the uploader creates it) but not on a
  // machine running the bundle straight from a checkout, where the write used
  // to ENOENT. connectDeps kills stale servers by this pidfile, so a missing
  // one silently loses that protection.
  mkdirSync(dirname(PID_FILE), { recursive: true })
  writeFileSync(PID_FILE, String(process.pid))
} catch (err) {
  log.warn('failed to write pid file', err)
}

const port = Number(process.env.PORT ?? 8765)
const bindHost = process.env.HOST ?? '127.0.0.1'
const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost'

/**
 * A token generated per launch (`SWITCHBOARD_TOKEN=$(openssl rand -hex 12)`)
 * invalidates every phone that already paired, and the failure looks like a
 * network fault rather than an auth one. So when binding beyond loopback without
 * an explicit token, persist one and reuse it across restarts.
 *
 * Deliberately NOT done for a loopback bind: the desktop dials its ssh-tunnelled
 * remotes with no token at all, and switching that on would break the existing
 * remote-machines flow.
 */
function stableToken(): string {
  const file = join(homedir(), '.switchboard-server', 'token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // No token file yet, which is the normal first-run case.
  }
  const fresh = randomBytes(12).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, fresh, { mode: 0o600 })
    log.info(`generated a pairing token and saved it to ${file}`)
  } catch (err) {
    log.warn('could not persist the pairing token, it will change on restart', err)
  }
  return fresh
}

const token = process.env.SWITCHBOARD_TOKEN ?? (isLoopback ? undefined : stableToken())
const wss = new WebSocketServer({ port, host: bindHost })
const wsHost = new WsHost(wss, token)

// Second listener speaking newline-delimited JSON over raw TCP. This is what a
// phone reaches through Google's IAP relay: IAP forwards an arbitrary VM port
// and hands the client a RAW TCP stream, so there is no WebSocket to speak.
// Same handlers, same frames, different framing. Off unless TCP_PORT is set.
const tcpPortRaw = process.env.TCP_PORT
// IAP forwards to the VM's INTERNAL interface, so this listener cannot be
// loopback-only or the relay finds nothing. It therefore always requires a
// token, independently of the WebSocket listener (which stays on 127.0.0.1
// behind the desktop's ssh -L tunnel - do not widen that).
const tcpEnabled = Boolean(tcpPortRaw) && Boolean(token)
if (tcpPortRaw && !token) {
  log.error('TCP_PORT set without SWITCHBOARD_TOKEN - refusing to expose the ndjson listener')
}
const tcpServer = tcpEnabled ? createServer() : null
const tcpHost = tcpServer ? new TcpHost(tcpServer, token) : null
const host = tcpHost ? new MultiHost(wsHost, tcpHost) : wsHost
if (tcpServer) {
  const tcpPort = Number(tcpPortRaw) || 8766
  const tcpBind = process.env.TCP_HOST ?? '0.0.0.0'
  tcpServer.on('error', (err) => log.error('tcp listener error', err))
  tcpServer.listen(tcpPort, tcpBind, () =>
    log.info(`ndjson/tcp listening on ${tcpBind}:${tcpPort} (for IAP-tunnelled clients)`),
  )
}

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

wss.on('listening', () => {
  log.info(`switchboard backend listening on ${bindHost}:${port} (v${__SERVER_VERSION__})`)
  void printPairingInfo()
})

/**
 * Print everything a phone needs to pair, including a scannable QR.
 *
 * Without this the operator has to reconstruct the URL by hand and, if the
 * token came from a shell substitution, they never saw it at all. Only runs when
 * bound beyond loopback, because a loopback-only server is not pairable anyway.
 * The token is printed deliberately: it is the pairing secret and this is the
 * operator's own terminal, which is the only place it can usefully appear.
 */
async function printPairingInfo(): Promise<void> {
  if (isLoopback) {
    // Silently binding loopback looks healthy while being unreachable from a
    // phone, which reads as a network fault. Say so.
    log.warn(
      `listening on ${bindHost} only - phones cannot reach this. Restart with HOST=0.0.0.0 to pair a device.`,
    )
    return
  }
  if (!token) return
  const addresses: string[] = []
  for (const [, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      addresses.push(addr.address)
    }
  }
  if (addresses.length === 0) {
    log.warn('no external IPv4 address found, cannot suggest a pairing URL')
    return
  }
  const url = `ws://${addresses[0]}:${port}?token=${token}`
  console.log('\nPair this backend in the mobile app (+ -> WebSocket -> Scan):\n')
  try {
    const QRCode = (await import('qrcode')).default
    console.log(await QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }))
  } catch (err) {
    log.warn('could not render the pairing QR', err)
  }
  console.log(`  URL:   ${url}`)
  if (addresses.length > 1) console.log(`  other addresses: ${addresses.slice(1).join(', ')}`)
  console.log(`  token: ${token}\n`)
}
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
