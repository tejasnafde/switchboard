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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { WebSocketServer } from 'ws'
import { MAX_FRAME_BYTES, WsHost } from '../main/backend/ws-host'
import { TcpHost } from '../main/backend/tcp-host'
import { MultiHost } from '../main/backend/multi-host'
import { registerPushHandlers } from '../main/ipc/push'
import { attachPushNotifier } from '../main/push/registry'
import { registerAppHandlers } from '../main/ipc/app'
import { registerFilesHandlers } from '../main/ipc/files'
import { registerGitHandlers } from '../main/ipc/git'
import { registerSttHandlers } from '../main/ipc/stt'
import { registerKanbanHandlers } from '../main/ipc/kanban'
import { registerProviderInstanceHandlers } from '../main/ipc/providerInstances'
import { registerTerminalHandlers } from '../main/ipc/terminal'
import { registerAgentHandlers } from '../main/ipc/agent'
import { ProviderRegistry } from '../main/provider/provider-registry'
import { disposeUsageProbes } from '../main/provider/usage'
import { startBridgeHost } from '../main/ide/bridge-host'
import { createMainLogger as createLogger } from '../main/logger'
import { createDefaultWorktreeCreationRuntime } from '../main/worktree-creation/runtime'
import { createBindLifecycle } from './lifecycle'
import { nodePidFileIo } from './pidfile'

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

const port = Number(process.env.PORT ?? 8765)
const bindHost = process.env.HOST ?? '127.0.0.1'
const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost'

/**
 * PID ownership is claimed on `listening` and released only while we still own
 * it - never at module load. Writing it here, before the bind could fail, is
 * what let a relaunch that immediately EADDRINUSE'd overwrite the pid of the
 * process actually holding the port; the bootstrap then killed a corpse on
 * every retry and the real server ran for 41h at 99% CPU. A bind failure now
 * exits nonzero promptly instead of logging and lingering. See
 * src/server/lifecycle.ts.
 */
const bindLifecycle = createBindLifecycle({
  pidFile: PID_FILE,
  pid: process.pid,
  io: nodePidFileIo,
  exit: (code) => process.exit(code),
  address: `${bindHost}:${port}`,
  log: {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    error: (m) => log.error(m),
  },
})

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
const wss = new WebSocketServer({ port, host: bindHost, maxPayload: MAX_FRAME_BYTES })
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

registerPushHandlers(host)
registerFilesHandlers(host)
registerGitHandlers(host)
registerSttHandlers(host)
registerProviderInstanceHandlers(host)
registerTerminalHandlers(host)
registerAgentHandlers(host)
host.handle(SERVER_VERSION_CHANNEL, () => __SERVER_VERSION__)

const registry = new ProviderRegistry(host)
const worktreeCreationRuntime = createDefaultWorktreeCreationRuntime(host, () => registry)
registerAppHandlers(host)
registerKanbanHandlers(host, {
  createWorktreeTransaction: (request) => worktreeCreationRuntime.createWorktreeTransaction(request),
  getWorktreeCreation: (request) => worktreeCreationRuntime.getWorktreeCreation(request),
  actOnWorktreeCreation: (request) => worktreeCreationRuntime.actOnWorktreeCreation(request),
})
// Notify paired phones about approvals, questions, finished turns and errors.
attachPushNotifier(registry.bus)
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
  // Claim the pidfile only now: we demonstrably hold the port, so the pid the
  // bootstrap's stale-server kill reads is the pid that actually owns it.
  bindLifecycle.onListening()
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
// A pre-listen failure (EADDRINUSE, EACCES) is fatal and exits nonzero without
// touching the pidfile; a post-listen socket fault is logged and survived.
wss.on('error', (err) => bindLifecycle.onError(err))

/**
 * Upper bound on graceful teardown. `wss.close(cb)` never invokes `cb` while
 * any client is still connected (ws's own behaviour, not a bug here), and a
 * phone or LAN client that never disconnects would otherwise keep this
 * process alive - untracked by the pidfile's owner-only contract - forever.
 * Terminating every client below is the real fix; this is the backstop for
 * whatever that misses (a hung provider teardown, a socket that resists
 * `.terminate()`).
 */
const SHUTDOWN_FORCE_EXIT_MS = 5_000

let shuttingDown = false

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Idempotent: a second SIGTERM (some process managers send it again if
    // the first is not acknowledged quickly) must not re-run teardown - that
    // would double-close sockets already being closed and race two exits.
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${sig} - shutting down`)

    const finish = (code: number) => {
      clearTimeout(forceExitTimer)
      // Ownership-checked, and only now that shutdown is actually completing
      // (or has been forced) - not at signal receipt, where a still-listening
      // process releasing its own pidfile would let a racing bootstrap start
      // a second server that immediately EADDRINUSEs against us. See
      // src/server/lifecycle.ts.
      bindLifecycle.onShutdown(sig)
      process.exit(code)
    }
    // Not unref'd: its entire purpose is to guarantee an exit even if
    // something below never resolves, so it must not depend on the event
    // loop otherwise going idle.
    const forceExitTimer = setTimeout(() => {
      log.error(`shutdown did not complete within ${SHUTDOWN_FORCE_EXIT_MS}ms - forcing exit`)
      finish(1)
    }, SHUTDOWN_FORCE_EXIT_MS)

    // process.exit skips the probe's own `finally`, so kill any survivor here.
    disposeUsageProbes()

    // `wss.close()` alone stops accepting new connections but, per `ws`,
    // never fires its callback while `wss.clients` is non-empty - a paired
    // phone or LAN client that never disconnects would hold this process
    // open indefinitely. Terminate every open socket first so close always
    // completes promptly.
    for (const client of wss.clients) client.terminate()
    tcpHost?.dispose()

    void registry.stopAll().finally(() => {
      wss.close(() => {
        if (tcpServer) tcpServer.close(() => finish(0))
        else finish(0)
      })
    })
  })
}
