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
import { nextConnectionStatus, type ConnectionStatus, type ConnectionEvent } from './connectionStatus'
import { reconnectDelay } from './reconnectBackoff'

export interface TunnelProcess {
  kill: () => void
  /** reason is a one-line summary of the process's stderr (e.g. "Permission denied"), when there was one. */
  onExit: (cb: (reason?: string) => void) => void
}

/** Hooks the ConnectionManager threads into a provision run. */
export interface ProvisionHooks {
  /** One coarse event per provision step (upload bundle, npm install, ...). */
  onProgress?: (label: string) => void
  /** Registers the live provisioning child so disconnect() can kill it mid-flight. */
  onChild?: (child: { kill: () => void }) => void
}

export interface ConnectionManagerDeps {
  /** Allocates a free local port. When `preferred` is given, tries to reuse it
   *  (reconnects keep the ws URL stable) and falls back to a fresh port only
   *  when binding it fails - something else grabbed it in the meantime. */
  allocatePort: (preferred?: number) => Promise<number>
  spawnTunnel: (command: string, args: string[]) => TunnelProcess
  /** Resolves ok once the remote backend answers over the tunnel; reason carries the last failure (version mismatch, timeout). */
  waitForHealth: (url: string) => Promise<{ ok: boolean; reason?: string }>
  remotePort: number
  remoteCommand: string
  /**
   * url is the local ws:// to dial when connected, null otherwise. reason is
   * set on error/fail transitions. detail is a short human-readable progress
   * label ('npm install ...', 'waiting for server…') for the busy states.
   */
  onStatus: (machineId: string, status: ConnectionStatus, url: string | null, reason?: string, detail?: string) => void
  /** Install/upgrade the remote backend before the tunnel. 'no-node' aborts. */
  provision?: (machine: Machine, hooks?: ProvisionHooks) => Promise<{ action: string }>
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
  /** Local tunnel port, pinned for the whole connection lifecycle so reconnect
   *  attempts keep the same ws URL (the renderer's transport survives blips).
   *  Cleared on a manual disconnect - a fresh connect may allocate anew. */
  port: number | null
  proc: TunnelProcess | null
  /** Live provisioning child (ssh running an install step), killable on disconnect. */
  provisionChild: { kill: () => void } | null
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

  /** Live status snapshot for renderer rehydration: a reloaded renderer has no
   *  transports for machines main still holds connected, and no status event
   *  will fire until something changes - this lets it pull the current state. */
  snapshot(): Array<{ machineId: string; status: ConnectionStatus; url: string | null }> {
    return [...this.conns.keys()].map((machineId) => ({
      machineId,
      status: this.statusOf(machineId),
      url: this.urlOf(machineId),
    }))
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
    conn.port = null // manual disconnect releases the pinned port; a fresh connect may allocate anew
    conn.proc?.kill()
    // A cancel mid-provision must also kill the live ssh child running the
    // install step - the epoch guard alone leaves it running to completion.
    conn.provisionChild?.kill()
    conn.provisionChild = null
    this.transition(machineId, 'disconnect')
  }

  /** Kill every tracked tunnel (app quit) so ssh doesn't reparent to launchd. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)))
  }

  private async attempt(machine: Machine): Promise<void> {
    const prev = this.conns.get(machine.id)
    if (prev?.intentional) return
    if (prev && (prev.status === 'connecting' || prev.status === 'provisioning' || prev.status === 'connected')) return

    // Claim the slot synchronously, before the first await - otherwise two rapid
    // connect() calls both pass the guard above and each spawns its own tunnel.
    const epoch = (prev?.epoch ?? 0) + 1
    this.conns.set(machine.id, {
      status: prev?.status ?? 'offline',
      url: prev?.url ?? '',
      port: prev?.port ?? null,
      proc: null,
      provisionChild: null,
      attempts: prev?.attempts ?? 0,
      intentional: false,
      epoch,
    })
    this.transition(machine.id, 'connect')

    try {
      // Reuse the previous attempt's port so a reconnect keeps the same ws URL
      // and the renderer's transport survives the blip instead of being replaced.
      const port = await this.deps.allocatePort(prev?.port ?? undefined)
      const claimed = this.conns.get(machine.id)
      if (!claimed || claimed.epoch !== epoch) return
      const url = `ws://127.0.0.1:${port}`
      claimed.url = url
      claimed.port = port

      if (this.deps.provision) {
        let res: { action: string }
        try {
          res = await this.deps.provision(machine, {
            // Fires once per real install step - a probe that comes back
            // 'ready' never calls this, so a warm remote skips straight from
            // 'connecting' to the tunnel without flashing 'provisioning'.
            onProgress: (label) => {
              if (this.conns.get(machine.id)?.epoch !== epoch) return
              this.transition(machine.id, 'provision', undefined, label)
            },
            onChild: (child) => {
              const c = this.conns.get(machine.id)
              if (!c || c.epoch !== epoch) {
                // Attempt already superseded/cancelled - reap the orphan now.
                child.kill()
                return
              }
              c.provisionChild = child
            },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.deps.onLog?.(`provision failed for ${machine.name}: ${message}`)
          return void this.transition(machine.id, 'fail', message)
        } finally {
          const c = this.conns.get(machine.id)
          if (c && c.epoch === epoch) c.provisionChild = null
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
      proc.onExit((reason) => this.onFailure(machine, epoch, reason))
      const conn = this.conns.get(machine.id)
      if (!conn || conn.epoch !== epoch) return
      conn.proc = proc

      // Leaves 'provisioning' (if we were there) and stamps the health-poll
      // phase; a single coarse event at poll start, not one per poll tick.
      this.transition(machine.id, 'connect', undefined, 'waiting for server…')

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

    const max = this.deps.maxReconnects ?? 0
    if (conn.attempts < max) {
      conn.attempts++
      // Budget remains: this is a self-healing blip, not a terminal failure.
      // The renderer keeps the machine's bindings and skips the red pip.
      this.transition(machine.id, 'retry', reason)
      const delay = (this.deps.reconnectDelayMs ?? ((n) => reconnectDelay(n, { baseMs: 1000, capMs: 30_000 })))(conn.attempts)
      // A manual connect/disconnect in the meantime bumps the epoch (or flips
      // status); this timer must then no-op instead of firing an interleaved attempt.
      const scheduledEpoch = conn.epoch
      ;(this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
        const current = this.conns.get(machine.id)
        if (!current || current.epoch !== scheduledEpoch) return
        if (current.status === 'connecting' || current.status === 'provisioning' || current.status === 'connected') return
        return this.attempt(machine)
      }, delay)
    } else {
      this.transition(machine.id, 'fail', reason)
    }
  }

  private transition(machineId: string, event: ConnectionEvent, reason?: string, detail?: string): void {
    const conn = this.conns.get(machineId)
    if (!conn) return
    const next = nextConnectionStatus(conn.status, event)
    // Same-status events still emit when they carry a detail (per-step
    // provisioning progress, health-poll start) - the renderer needs those.
    if (next === conn.status && detail === undefined) return
    conn.status = next
    this.deps.onStatus(machineId, next, this.urlOf(machineId), reason, detail)
  }
}
