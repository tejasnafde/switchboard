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
import { createMainLogger } from '../logger'
import type { TunnelProcess } from './connectionManager'

const log = createMainLogger('machines:tunnel')

export const REMOTE_PORT = 8765
export const REMOTE_COMMAND = `PORT=${REMOTE_PORT} node $HOME/.switchboard-server/index.cjs`

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
 * Poll the tunnel until the remote backend's WS accepts a connection, or give
 * up. Guards against a stalled handshake (TCP connects but the WS upgrade
 * never completes) via `handshakeTimeout` plus a per-tick fallback timer -
 * either alone can leave a tick with no 'open' and no 'error', which would
 * otherwise hang the whole probe forever.
 */
export function waitForHealth(url: string, attempts = 30, intervalMs = 1000): Promise<boolean> {
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
      const ws = new WebSocket(url, { handshakeTimeout: intervalMs })
      const fallback = setTimeout(() => {
        if (settled) return
        settled = true
        ws.terminate()
        recordFailure(new Error('handshake stalled'))
      }, intervalMs)
      ws.once('open', () => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        log.info(`health ok after ${tries + 1} attempt(s)`, { url })
        ws.close()
        resolve(true)
      })
      ws.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        recordFailure(err)
      })
    }
    tick()
  })
}
