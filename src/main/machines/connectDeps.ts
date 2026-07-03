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
import type { TunnelProcess } from './connectionManager'

const log = createMainLogger('machines:tunnel')

export const REMOTE_PORT = 8765

// Duplicated in src/server/index.ts - that file can't be imported here since
// it boots a WebSocketServer as a side effect of module load. Keep the two
// literals in sync.
export const SERVER_VERSION_CHANNEL = 'server:version'

// Kill any lingering server (pidfile written by the server on boot) before
// launching - a stale process holding the port would EADDRINUSE the new one
// while ssh's -L forward keeps reaching the old, possibly out-of-protocol server.
const D = '$HOME/.switchboard-server'
export const REMOTE_COMMAND = `D=${D}; [ -f "$D/server.pid" ] && kill "$(cat "$D/server.pid")" 2>/dev/null && sleep 1; PORT=${REMOTE_PORT} node $D/index.cjs`

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
  const child = spawn(command, args)
  // Surface ssh + remote-server output: this is where a crashed server, an
  // EADDRINUSE from a lingering server, or an ssh/forward error shows up.
  child.stdout.on('data', (d) => log.info(`tunnel stdout: ${String(d).trimEnd()}`))
  child.stderr.on('data', (d) => log.warn(`tunnel stderr: ${String(d).trimEnd()}`))
  child.on('exit', (code, signal) => log.info('tunnel exited', { code, signal }))
  child.on('error', (err) => log.warn('tunnel spawn error', err))
  return {
    kill: () => child.kill(),
    onExit: (cb) => child.once('exit', cb),
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
export function waitForHealth(url: string, attempts = 30, intervalMs = 1000): Promise<boolean> {
  const expectedVersion = appVersion()
  return new Promise((resolve) => {
    let tries = 0
    const recordFailure = (err: Error) => {
      tries++
      if (tries === 1 || tries % 5 === 0) log.warn(`health attempt ${tries}/${attempts} failed`, { url, err: err.message })
      if (tries >= attempts) {
        log.warn(`health gave up after ${attempts} attempts`, { url })
        resolve(false)
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
        resolve(true)
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
