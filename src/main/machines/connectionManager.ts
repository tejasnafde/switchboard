/**
 * Drives the connect/disconnect lifecycle for a remote machine: allocate a
 * local port, open an ssh tunnel that boots the remote backend, probe it for
 * health, and track the resulting `ws://127.0.0.1:<port>` URL that per-machine
 * transport routing (M4b step 2) dials. All side effects (port alloc, spawn,
 * health probe) are injected so the orchestration is unit-tested without ssh.
 */
import type { Machine } from '@shared/machines'
import { buildTunnelCommand } from './sshTunnel'
import { nextConnectionStatus, type ConnectionStatus } from './connectionStatus'

export interface TunnelProcess {
  kill: () => void
  onExit: (cb: () => void) => void
}

export interface ConnectionManagerDeps {
  allocatePort: () => Promise<number>
  spawnTunnel: (command: string, args: string[]) => TunnelProcess
  /** Resolves true once the remote backend answers over the tunnel, false on timeout. */
  waitForHealth: (url: string) => Promise<boolean>
  remotePort: number
  remoteCommand: string
  /** url is the local ws:// to dial when connected, null otherwise. */
  onStatus: (machineId: string, status: ConnectionStatus, url: string | null) => void
  /** Install/upgrade the remote backend before the tunnel. 'no-node' aborts. */
  provision?: (machine: Machine) => Promise<{ action: string }>
}

interface Conn {
  status: ConnectionStatus
  url: string
  proc: TunnelProcess | null
}

export class ConnectionManager {
  private readonly conns = new Map<string, Conn>()

  constructor(private readonly deps: ConnectionManagerDeps) {}

  statusOf(machineId: string): ConnectionStatus {
    return this.conns.get(machineId)?.status ?? 'offline'
  }

  /** The local WS URL to dial for a connected machine, or null if not connected. */
  urlOf(machineId: string): string | null {
    const conn = this.conns.get(machineId)
    return conn?.status === 'connected' ? conn.url : null
  }

  async connect(machine: Machine): Promise<void> {
    const existing = this.statusOf(machine.id)
    if (existing === 'connecting' || existing === 'connected') return

    const port = await this.deps.allocatePort()
    const url = `ws://127.0.0.1:${port}`
    this.conns.set(machine.id, { status: 'offline', url, proc: null })
    this.transition(machine.id, 'connect')

    if (this.deps.provision) {
      try {
        const res = await this.deps.provision(machine)
        if (res.action === 'no-node') return void this.transition(machine.id, 'fail')
      } catch {
        return void this.transition(machine.id, 'fail')
      }
      if (this.statusOf(machine.id) !== 'connecting') return // disconnected mid-provision
    }

    const { command, args } = buildTunnelCommand(machine, {
      localPort: port,
      remotePort: this.deps.remotePort,
      remoteCommand: this.deps.remoteCommand,
    })
    const proc = this.deps.spawnTunnel(command, args)
    proc.onExit(() => this.transition(machine.id, 'fail'))
    const conn = this.conns.get(machine.id)
    if (conn) conn.proc = proc

    const healthy = await this.deps.waitForHealth(url)
    if (healthy) {
      this.transition(machine.id, 'healthy')
    } else {
      proc.kill()
      this.transition(machine.id, 'fail')
    }
  }

  async disconnect(machineId: string): Promise<void> {
    const conn = this.conns.get(machineId)
    if (!conn) return
    conn.proc?.kill()
    this.transition(machineId, 'disconnect')
  }

  private transition(machineId: string, event: 'connect' | 'healthy' | 'fail' | 'disconnect'): void {
    const conn = this.conns.get(machineId)
    if (!conn) return
    const next = nextConnectionStatus(conn.status, event)
    if (next === conn.status) return
    conn.status = next
    this.deps.onStatus(machineId, next, this.urlOf(machineId))
  }
}
