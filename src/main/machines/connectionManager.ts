/**
 * Drives the connect/disconnect lifecycle for a remote machine: allocate a
 * local port, optionally provision, open an ssh tunnel, probe for health, and
 * track the resulting `ws://127.0.0.1:<port>` URL that per-session routing
 * dials. An established tunnel that drops auto-reconnects with backoff up to
 * `maxReconnects`. All side effects are injected so the orchestration is
 * unit-tested without ssh.
 */
import type { Machine } from '@shared/machines'
import { buildTunnelCommand } from './sshTunnel'
import { nextConnectionStatus, type ConnectionStatus } from './connectionStatus'
import { reconnectDelay } from './reconnectBackoff'

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
  /** url is the local ws:// to dial when connected, null otherwise. reason is set on error/fail transitions. */
  onStatus: (machineId: string, status: ConnectionStatus, url: string | null, reason?: string) => void
  /** Install/upgrade the remote backend before the tunnel. 'no-node' aborts. */
  provision?: (machine: Machine) => Promise<{ action: string }>
  /** Auto-reconnect a dropped tunnel this many times before giving up (default 0). */
  maxReconnects?: number
  reconnectDelayMs?: (attempt: number) => number
  setTimer?: (fn: () => void | Promise<void>, ms: number) => void
  /** Optional log sink - this module is DI-pure and takes no logger dependency directly. */
  onLog?: (msg: string) => void
}

interface Conn {
  status: ConnectionStatus
  url: string
  proc: TunnelProcess | null
  attempts: number
  intentional: boolean
  epoch: number
}

export class ConnectionManager {
  private readonly conns = new Map<string, Conn>()

  constructor(private readonly deps: ConnectionManagerDeps) {}

  statusOf(machineId: string): ConnectionStatus {
    return this.conns.get(machineId)?.status ?? 'offline'
  }

  urlOf(machineId: string): string | null {
    const conn = this.conns.get(machineId)
    return conn?.status === 'connected' ? conn.url : null
  }

  /** User-initiated connect: clears the reconnect budget, then attempts. */
  async connect(machine: Machine): Promise<void> {
    const conn = this.conns.get(machine.id)
    if (conn) {
      conn.attempts = 0
      conn.intentional = false
    }
    await this.attempt(machine)
  }

  async disconnect(machineId: string): Promise<void> {
    const conn = this.conns.get(machineId)
    if (!conn) return
    conn.intentional = true
    conn.epoch++ // invalidate any in-flight attempt + pending reconnect
    conn.proc?.kill()
    this.transition(machineId, 'disconnect')
  }

  /** Kill every tracked tunnel (app quit) so ssh doesn't reparent to launchd. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)))
  }

  private async attempt(machine: Machine): Promise<void> {
    const prev = this.conns.get(machine.id)
    if (prev?.intentional) return
    if (prev && (prev.status === 'connecting' || prev.status === 'connected')) return

    // Claim the slot synchronously, before the first await - otherwise two rapid
    // connect() calls both pass the guard above and each spawns its own tunnel.
    const epoch = (prev?.epoch ?? 0) + 1
    this.conns.set(machine.id, {
      status: prev?.status ?? 'offline',
      url: prev?.url ?? '',
      proc: null,
      attempts: prev?.attempts ?? 0,
      intentional: false,
      epoch,
    })
    this.transition(machine.id, 'connect')

    try {
      const port = await this.deps.allocatePort()
      const claimed = this.conns.get(machine.id)
      if (!claimed || claimed.epoch !== epoch) return
      const url = `ws://127.0.0.1:${port}`
      claimed.url = url

      if (this.deps.provision) {
        let res: { action: string }
        try {
          res = await this.deps.provision(machine)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.deps.onLog?.(`provision failed for ${machine.name}: ${message}`)
          return void this.transition(machine.id, 'fail', message)
        }
        if (res.action === 'no-node') {
          return void this.transition(machine.id, 'fail', 'no node runtime found on the remote')
        }
        if (this.conns.get(machine.id)?.epoch !== epoch) return
      }

      const { command, args } = buildTunnelCommand(machine, {
        localPort: port,
        remotePort: this.deps.remotePort,
        remoteCommand: this.deps.remoteCommand,
      })
      const proc = this.deps.spawnTunnel(command, args)
      proc.onExit(() => this.onFailure(machine, epoch))
      const conn = this.conns.get(machine.id)
      if (!conn || conn.epoch !== epoch) return
      conn.proc = proc

      const healthy = await this.deps.waitForHealth(url)
      if (this.conns.get(machine.id)?.epoch !== epoch) return
      if (healthy) {
        conn.attempts = 0
        this.transition(machine.id, 'healthy')
      } else {
        this.onFailure(machine, epoch, 'health check failed (timeout)')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.onLog?.(`connect attempt failed for ${machine.name}: ${message}`)
      if (this.conns.get(machine.id)?.epoch === epoch) this.transition(machine.id, 'fail', message)
    }
  }

  /** A failed/dropped attempt: reconnect with backoff if budget remains, else error. */
  private onFailure(machine: Machine, epoch: number, reason?: string): void {
    const conn = this.conns.get(machine.id)
    if (!conn || conn.intentional || conn.epoch !== epoch) return
    conn.epoch++ // any later callback from this attempt is now stale
    conn.proc?.kill()
    conn.proc = null

    const max = this.deps.maxReconnects ?? 0
    if (conn.attempts < max) {
      conn.attempts++
      this.transition(machine.id, 'fail', reason)
      const delay = (this.deps.reconnectDelayMs ?? ((n) => reconnectDelay(n, { baseMs: 1000, capMs: 30_000 })))(conn.attempts)
      // A manual connect/disconnect in the meantime bumps the epoch (or flips
      // status); this timer must then no-op instead of firing an interleaved attempt.
      const scheduledEpoch = conn.epoch
      ;(this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
        const current = this.conns.get(machine.id)
        if (!current || current.epoch !== scheduledEpoch) return
        if (current.status === 'connecting' || current.status === 'connected') return
        return this.attempt(machine)
      }, delay)
    } else {
      this.transition(machine.id, 'fail', reason)
    }
  }

  private transition(
    machineId: string,
    event: 'connect' | 'healthy' | 'fail' | 'disconnect',
    reason?: string,
  ): void {
    const conn = this.conns.get(machineId)
    if (!conn) return
    const next = nextConnectionStatus(conn.status, event)
    if (next === conn.status) return
    conn.status = next
    this.deps.onStatus(machineId, next, this.urlOf(machineId), reason)
  }
}
