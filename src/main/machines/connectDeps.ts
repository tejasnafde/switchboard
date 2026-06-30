/**
 * Node-side ConnectionManager deps: free-port allocation, ssh-tunnel spawn, and
 * a WebSocket health probe over the tunnel. Kept out of connectionManager.ts so
 * the lifecycle stays unit-testable without sockets or child processes.
 *
 * Deploy contract: the remote must expose `switchboard-server` on PATH, which
 * boots the headless backend (see src/server/index.ts) on REMOTE_PORT.
 */
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import type { TunnelProcess } from './connectionManager'

export const REMOTE_PORT = 8765
// Runs the bundle the provisioner installs under ~/.switchboard-server.
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
  const child = spawn(command, args, { stdio: 'ignore' })
  return {
    kill: () => child.kill(),
    onExit: (cb) => child.once('exit', cb),
  }
}

/** Poll the tunnel until the remote backend's WS accepts a connection, or give up. */
export function waitForHealth(url: string, attempts = 30, intervalMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let tries = 0
    const tick = () => {
      const ws = new WebSocket(url)
      ws.once('open', () => {
        ws.close()
        resolve(true)
      })
      ws.once('error', () => {
        if (++tries >= attempts) resolve(false)
        else setTimeout(tick, intervalMs)
      })
    }
    tick()
  })
}
