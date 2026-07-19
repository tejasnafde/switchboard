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
  /** Human-readable cause of an exit (summarized ssh stderr), if any was captured. */
  exitReason?: () => string | undefined
}

export interface ConnectionManagerDeps {
  allocatePort: () => Promise<number>
  /** Stable-per-machine local forward for the remote code-server (callers
   *  persist it - the webview origin scopes extension state). Omitted = no
   *  IDE forward. */
  allocateIdePort?: (machineId: string) => Promise<number>
  /** Remote port the machine's code-server binds (connectDeps.REMOTE_IDE_PORT). */
  remoteIdePort?: number
  spawnTunnel: (command: string, args: string[]) => TunnelProcess
  /** Resolves ok once the remote backend answers over the tunnel; reason carries the last failure (version mismatch, timeout). */
  waitForHealth: (url: string) => Promise<{ ok: boolean; reason?: string }>
  remotePort: number
  remoteCommand: string
  /**
   * url is the local ws:// to dial when connected, null otherwise. reason is
   * set on error/fail transitions, and carries progress detail ("npm install…")
   * on repeated 'connecting' emissions. willRetry marks an error that an
   * auto-reconnect is about to retry, so the UI can show "reconnecting" instead
   * of a dead-end failure.
   */
  onStatus: (
    machineId: string,
    status: ConnectionStatus,
    url: string | null,
    reason?: string,
    willRetry?: boolean,
    idePort?: number | null
  ) => void
  /** Install/upgrade the remote backend before the tunnel. 'no-node' aborts. onStep reports progress labels. */
  provision?: (machine: Machine, onStep?: (label: string) => void) => Promise<{ action: string }>
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
  /** Reused across auto-reconnects so the tunnel URL stays stable and the
   *  renderer's transport swap is seamless. Known ceiling: another process
   *  can grab the freed port between attempts, burning the retry budget;
   *  a manual connect() clears it and re-allocates. */
  port: number | null
  /** Local forward to the machine's code-server, when the IDE forward is on. */
  idePort: number | null
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

  /** Local forwarded port of the machine's code-server, when connected. */
  idePortOf(machineId: string): number | null {
    const conn = this.conns.get(machineId)
    return conn?.status === 'connected' ? conn.idePort : null
  }

  /** Snapshot of every tracked connection, for a reloaded renderer to resync from. */
  statuses(): Record<string, { status: ConnectionStatus; url: string | null; idePort: number | null }> {
    const out: Record<string, { status: ConnectionStatus; url: string | null; idePort: number | null }> = {}
    for (const [id, conn] of this.conns) out[id] = { status: conn.status, url: this.urlOf(id), idePort: this.idePortOf(id) }
    return out
  }

  /** User-initiated connect: clears the reconnect budget, then attempts. */
  async connect(machine: Machine): Promise<void> {
    const conn = this.conns.get(machine.id)
    if (conn) {
      conn.attempts = 0
      conn.intentional = false
      // Drop the remembered port: if it was stolen while we were down, every
      // auto-reconnect failed on it - a manual retry must not inherit that fate.
      conn.port = null
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
      port: prev?.port ?? null,
      idePort: prev?.idePort ?? null,
      proc: null,
      attempts: prev?.attempts ?? 0,
      intentional: false,
      epoch,
    })
    this.transition(machine.id, 'connect')

    try {
      const port = this.conns.get(machine.id)?.port ?? (await this.deps.allocatePort())
      const idePort =
        this.conns.get(machine.id)?.idePort ??
        (this.deps.allocateIdePort ? await this.deps.allocateIdePort(machine.id) : null)
      const claimed = this.conns.get(machine.id)
      if (!claimed || claimed.epoch !== epoch) return
      const url = `ws://127.0.0.1:${port}`
      claimed.port = port
      claimed.idePort = idePort
      claimed.url = url

      if (this.deps.provision) {
        let res: { action: string }
        try {
          res = await this.deps.provision(machine, (label) => this.progress(machine.id, epoch, label))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.deps.onLog?.(`provision failed for ${machine.name}: ${message}`)
          // Through onFailure, not a terminal fail: during an auto-reconnect
          // the probe rides the same network that just dropped, and a terminal
          // error here would collapse the whole retry budget to one attempt.
          return void this.onFailure(machine, epoch, message)
        }
        if (res.action === 'no-node') {
          return void this.transition(machine.id, 'fail', 'no node runtime found on the remote')
        }
        if (this.conns.get(machine.id)?.epoch !== epoch) return
      }

      this.progress(machine.id, epoch, 'opening ssh tunnel')
      const { command, args } = buildTunnelCommand(machine, {
        localPort: port,
        remotePort: this.deps.remotePort,
        ...(idePort && this.deps.remoteIdePort
          ? { extraForwards: [{ localPort: idePort, remotePort: this.deps.remoteIdePort }] }
          : {}),
        remoteCommand: this.deps.remoteCommand,
      })
      const proc = this.deps.spawnTunnel(command, args)
      proc.onExit(() => this.onFailure(machine, epoch, proc.exitReason?.()))
      const conn = this.conns.get(machine.id)
      if (!conn || conn.epoch !== epoch) return
      conn.proc = proc

      this.progress(machine.id, epoch, 'waiting for the remote server')
      const health = await this.deps.waitForHealth(url)
      if (this.conns.get(machine.id)?.epoch !== epoch) return
      if (health.ok) {
        conn.attempts = 0
        this.transition(machine.id, 'healthy')
      } else {
        this.onFailure(machine, epoch, health.reason ?? 'health check failed')
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
    // The optional IDE forward rides the same tunnel under
    // ExitOnForwardFailure - if its local port was taken, the whole tunnel
    // died. Re-allocate on the next attempt instead of colliding again.
    conn.idePort = null

    const max = this.deps.maxReconnects ?? 0
    if (conn.attempts < max) {
      conn.attempts++
      this.transition(machine.id, 'fail', reason, true)
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

  /** Cosmetic progress detail while an attempt is in flight, re-emitted as 'connecting'. */
  private progress(machineId: string, epoch: number, detail: string): void {
    const conn = this.conns.get(machineId)
    if (!conn || conn.epoch !== epoch || conn.status !== 'connecting') return
    this.deps.onStatus(machineId, 'connecting', null, detail)
  }

  private transition(
    machineId: string,
    event: 'connect' | 'healthy' | 'fail' | 'disconnect',
    reason?: string,
    willRetry?: boolean,
  ): void {
    const conn = this.conns.get(machineId)
    if (!conn) return
    const next = nextConnectionStatus(conn.status, event)
    if (next === conn.status) return
    conn.status = next
    this.deps.onStatus(machineId, next, this.urlOf(machineId), reason, willRetry, this.idePortOf(machineId))
  }
}
