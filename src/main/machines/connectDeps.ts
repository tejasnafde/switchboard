/**
 * Node-side ConnectionManager deps: free-port allocation, ssh-tunnel spawn, and
 * a WebSocket health probe over the tunnel. Kept out of connectionManager.ts so
 * the lifecycle stays unit-testable without sockets or child processes.
 *
 * The provisioner installs the server under ~/.switchboard-server; the tunnel
 * boots it via REMOTE_COMMAND (wrapped to run as the machine's remoteUser).
 */
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { encodeFrame, decodeFrame } from '@shared/ws-protocol'
import { createMainLogger } from '../logger'
import { appVersion } from '../runtime'
import { REMOTE_SERVER_DIR } from './provisionCommands'
import { buildRemoteBootstrapCommand } from './remoteBootstrap'
import { summarizeSshError } from './sshError'
import { childProcessEnv } from '../shell-env'
import type { TunnelProcess } from './connectionManager'

const log = createMainLogger('machines:tunnel')

export const REMOTE_PORT = 8765

/** Remote code-server binds here (loopback-only; reached via the tunnel's
 *  second -L forward). Same private-convention family as REMOTE_PORT. */
export const REMOTE_IDE_PORT = 8766

/**
 * The remote sb-bridge WebSocket. Never tunneled: only the VM's own
 * code-server extension hosts dial it, and the intents they send travel on to
 * the desktop over the EXISTING backend socket (WsHost.emit). Loopback-only.
 */
export const REMOTE_BRIDGE_PORT = 8767

// Duplicated in src/server/index.ts - that file can't be imported here since
// it boots a WebSocketServer as a side effect of module load. Keep the two
// literals in sync.
export const SERVER_VERSION_CHANNEL = 'server:version'

/**
 * The remote bootstrap: reap a lingering server (by the pidfile the server
 * writes once it is listening), restart the managed code-server, put the
 * managed CLI bin dir on PATH, then exec the backend.
 *
 * The reaping and PATH rules live in remoteBootstrap.ts, where they are
 * unit-tested; see that file for why the kill escalates TERM -> KILL under a
 * bound, why every signal is identity-guarded against a recycled pid, and why
 * `pkill` is off the table.
 */
export const REMOTE_COMMAND = buildRemoteBootstrapCommand({
  serverDir: REMOTE_SERVER_DIR,
  port: REMOTE_PORT,
  idePort: REMOTE_IDE_PORT,
  bridgePort: REMOTE_BRIDGE_PORT,
})

export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('failed to allocate a local port'))))
    })
  })
}

export function spawnTunnel(command: string, args: string[]): TunnelProcess {
  log.info('spawn tunnel', { command, args })
  const child = spawn(command, args, { env: childProcessEnv() })
  // Keep the tail of stderr so a dying tunnel can report WHY it died
  // ("Permission denied", "Connection refused") instead of a bare error pip.
  let stderrTail = ''
  // Surface ssh + remote-server output: this is where a crashed server, an
  // EADDRINUSE from a lingering server, or an ssh/forward error shows up.
  child.stdout.on('data', (d) => log.info(`tunnel stdout: ${String(d).trimEnd()}`))
  child.stderr.on('data', (d) => {
    log.warn(`tunnel stderr: ${String(d).trimEnd()}`)
    stderrTail = (stderrTail + String(d)).slice(-4096)
  })
  child.on('exit', (code, signal) => log.info('tunnel exited', { code, signal }))
  child.on('error', (err) => {
    log.warn('tunnel spawn error', err)
    stderrTail = (stderrTail + err.message).slice(-4096)
  })
  return {
    kill: () => child.kill(),
    onExit: (cb) => child.once('exit', cb),
    exitReason: () => {
      const summary = summarizeSshError(stderrTail)
      return summary ? `tunnel closed: ${summary}` : undefined
    },
  }
}

/**
 * Poll the tunnel until the remote backend's WS opens AND answers a
 * `server:version` request with a version matching this build, or give up.
 * A version mismatch (or an old server that has no handler for the channel,
 * or one that never responds at all) counts as a failed attempt, not a pass -
 * otherwise a stale server left behind by an ungraceful tunnel drop would
 * silently keep serving an old protocol behind a freshly-passed health check.
 *
 * Guards against a stalled handshake or a stalled version response (TCP/WS
 * connects but nothing useful ever arrives) via `handshakeTimeout` plus a
 * per-tick fallback timer that gets rearmed once the socket opens - either
 * timer alone can leave a tick with no terminal event, which would otherwise
 * hang the whole probe forever.
 */
export function waitForHealth(
  url: string,
  attempts = 30,
  intervalMs = 1000,
): Promise<{ ok: boolean; reason?: string }> {
  const expectedVersion = appVersion()
  return new Promise((resolve) => {
    let tries = 0
    let lastReason: string | undefined
    const recordFailure = (err: Error) => {
      tries++
      lastReason = err.message
      if (tries === 1 || tries % 5 === 0) log.warn(`health attempt ${tries}/${attempts} failed`, { url, err: err.message })
      if (tries >= attempts) {
        log.warn(`health gave up after ${attempts} attempts`, { url })
        resolve({ ok: false, reason: lastReason })
      } else {
        setTimeout(tick, intervalMs)
      }
    }
    const tick = () => {
      let settled = false
      let fallback: ReturnType<typeof setTimeout>
      const ws = new WebSocket(url, { handshakeTimeout: intervalMs })
      const armFallback = (message: string) => {
        fallback = setTimeout(() => fail(new Error(message)), intervalMs)
      }
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        ws.terminate()
        recordFailure(err)
      }
      const succeed = () => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        log.info(`health ok after ${tries + 1} attempt(s)`, { url })
        ws.close()
        resolve({ ok: true })
      }
      armFallback('handshake stalled')
      ws.once('open', () => {
        if (settled) return
        clearTimeout(fallback)
        armFallback('version response timed out')
        ws.send(encodeFrame({ k: 'req', id: 1, ch: SERVER_VERSION_CHANNEL, args: [] }))
      })
      ws.once('message', (data: WebSocket.RawData) => {
        if (settled) return
        const frame = decodeFrame(data.toString())
        if (!frame || frame.k !== 'res' || frame.id !== 1) {
          fail(new Error('malformed version response'))
          return
        }
        if (frame.ok && frame.result === expectedVersion) {
          succeed()
          return
        }
        const got = frame.ok ? String(frame.result) : `error: ${frame.error}`
        log.warn('server version mismatch', { url, expected: expectedVersion, got })
        fail(new Error(`server version mismatch (local ${expectedVersion}, remote ${got})`))
      })
      ws.once('error', (err) => {
        fail(err)
      })
    }
    tick()
  })
}
