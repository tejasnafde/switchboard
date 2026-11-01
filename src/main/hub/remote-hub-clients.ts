/**
 * The desktop's own hub client to every connected machine, behind the
 * `hub_remote_children` flag: nothing opens while it is off.
 *
 * One `WsTransport` per machine, dialled through the tunnel `ConnectionManager`
 * holds (`urlOf`), with the machine's backend token (`tokenOf`) narrowed to
 * `['hub']` in the auth frame. An `authed` that grants anything else is an
 * older backend that dropped `scopes`, so the client closes and the machine
 * reads as needing an update; so does a `ready` without `hub_remote_child_v1`.
 * It does not share the renderer's transport. A status other than `connected`
 * closes the client; the next connect opens a new one and describes the
 * machine again.
 *
 * It also keeps the last `hub-remote:describe` answer per machine, read on
 * every connect and at most every 60 s on demand. An offline machine keeps its
 * last answer with its age; a failed read stores nothing.
 */
import WebSocket from 'ws'
import { HubRemoteChannels } from '@shared/ipc-channels'
import {
  HUB_REMOTE_AUTH_SCOPES,
  HUB_REMOTE_CAPABILITY,
  isHubAuthGrant,
  parseHubMachineDescription,
  type HubMachineDescription,
  type HubMachineEntry,
} from '@shared/hub-remote'
import type { Machine } from '@shared/machines'
import { WsTransport, type TransportSocket } from '@shared/ws-transport'
import type { ConnectionStatus } from '../machines/connection-status'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:remote-clients')

export const HUB_REMOTE_CALL_TIMEOUT_MS = 20_000
export const HUB_DESCRIBE_MAX_AGE_MS = 60_000

export type HubRemoteEvent = typeof HubRemoteChannels.OUTBOX | typeof HubRemoteChannels.CHILDREN_CHANGED
const HUB_REMOTE_EVENTS: readonly HubRemoteEvent[] = [HubRemoteChannels.OUTBOX, HubRemoteChannels.CHILDREN_CHANGED]

export type HubMachineRow = Pick<Machine, 'id' | 'name' | 'transportKind'>

export interface RemoteHubClientsDeps {
  /** `hub_remote_children`, read on every use. */
  enabled: () => boolean
  machines: () => readonly HubMachineRow[]
  statusOf: (machineId: string) => ConnectionStatus
  urlOf: (machineId: string) => string | null
  tokenOf: (machineId: string) => string | null
  createSocket?: (url: string) => TransportSocket
  now?: () => number
  callTimeoutMs?: number
}

type CallOutcome = 'ok' | 'not_connected' | 'refused' | 'timeout' | 'error'

export class HubRemoteCallError extends Error {
  constructor(
    readonly outcome: Exclude<CallOutcome, 'ok'>,
    message: string,
  ) {
    super(message)
  }
}

interface Client {
  /** Null when there is no token to dial with. */
  transport: WsTransport | null
  /** Null once the backend granted `['hub']` and sent `ready` with the capability; else why not. */
  ready: Promise<string | null>
  /** Set when the client gave up on this machine until its next connect. */
  problem: string | null
}

interface Snapshot {
  description: HubMachineDescription
  at: number
}

export class RemoteHubClients {
  private readonly clients = new Map<string, Client>()
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly describing = new Map<string, Promise<void>>()
  private readonly listeners = new Map<HubRemoteEvent, Set<(machineId: string, ...args: unknown[]) => void>>()
  private readonly now: () => number
  private readonly callTimeoutMs: number

  constructor(private readonly deps: RemoteHubClientsDeps) {
    this.now = deps.now ?? Date.now
    this.callTimeoutMs = deps.callTimeoutMs ?? HUB_REMOTE_CALL_TIMEOUT_MS
  }

  /** From `ConnectionManager`'s status: a connect opens a client and reads the machine, anything else closes it. */
  statusChanged(machineId: string, status: ConnectionStatus): void {
    this.close(machineId)
    if (status !== 'connected' || !this.deps.enabled()) return
    void this.refresh(machineId, 0)
  }

  /** The machine was deleted: close its client and forget its description. */
  remove(machineId: string): void {
    this.close(machineId)
    this.snapshots.delete(machineId)
  }

  closeAll(): void {
    for (const id of [...this.clients.keys()]) this.close(id)
  }

  /** Listen to a `hub-remote:*` event from any machine. Returns the unsubscribe. */
  on(event: HubRemoteEvent, handler: (machineId: string, ...args: unknown[]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  /**
   * Call a `hub-remote:*` channel on a machine. Refused at once when the
   * machine is not connected; fails after the call timeout, which covers the
   * client's own connect.
   */
  async invoke<T = unknown>(machineId: string, channel: string, ...args: unknown[]): Promise<T> {
    const span = perfSpan('hub.remote-call', { channel, machineId })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const call = (async () => {
        const client = this.clientFor(machineId)
        const problem = await client.ready
        if (problem || !client.transport) throw new HubRemoteCallError('refused', problem ?? 'no hub client')
        return client.transport.invoke<T>(channel, ...args)
      })()
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HubRemoteCallError(
                'timeout',
                `${this.nameOf(machineId)} did not answer ${channel} in ${Math.round(this.callTimeoutMs / 1000)} s`,
              ),
            ),
          this.callTimeoutMs,
        )
      })
      const result = await Promise.race([call, timeout])
      span.end({ outcome: 'ok' })
      return result
    } catch (err) {
      span.end({ outcome: err instanceof HubRemoteCallError ? err.outcome : 'error' })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Every machine for `list_machines`, after reading each connected machine
   * whose description is older than 60 s. Nothing is read with the flag off.
   */
  async entries(): Promise<HubMachineEntry[]> {
    const machines = this.deps.machines()
    if (this.deps.enabled()) await Promise.all(machines.map((m) => this.refresh(m.id, HUB_DESCRIBE_MAX_AGE_MS)))
    return machines.map((m) => this.entry(m))
  }

  /** The cached description and its time, for tests and later callers. */
  snapshotOf(machineId: string): Snapshot | null {
    return this.snapshots.get(machineId) ?? null
  }

  private entry(m: HubMachineRow): HubMachineEntry {
    const snap = this.snapshots.get(m.id)
    const connection = this.deps.statusOf(m.id)
    const problem = this.clients.get(m.id)?.problem ?? null
    return {
      id: m.id,
      name: m.name,
      transport: m.transportKind,
      status: problem && connection === 'connected' ? 'error' : connection,
      description: snap?.description ?? null,
      ageMs: snap ? this.now() - snap.at : null,
      problem,
    }
  }

  /** Read a connected machine's description when the cached one is `maxAgeMs` old or older. */
  private refresh(machineId: string, maxAgeMs: number): Promise<void> {
    const snap = this.snapshots.get(machineId)
    if (maxAgeMs > 0 && snap && this.now() - snap.at < maxAgeMs) return Promise.resolve()
    if (this.deps.statusOf(machineId) !== 'connected' || !this.deps.enabled()) return Promise.resolve()
    const running = this.describing.get(machineId)
    if (running) return running
    const read = this.invoke(machineId, HubRemoteChannels.DESCRIBE)
      .then((answer) => {
        const description = parseHubMachineDescription(answer)
        if (!description) {
          log.warn(`machine ${machineId} answered describe with a malformed description`)
          return
        }
        this.snapshots.set(machineId, { description, at: this.now() })
      })
      .catch((err: unknown) => {
        log.warn(`could not describe machine ${machineId}: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => this.describing.delete(machineId))
    this.describing.set(machineId, read)
    return read
  }

  private clientFor(machineId: string): Client {
    const name = this.nameOf(machineId)
    if (!this.deps.enabled()) throw new HubRemoteCallError('refused', 'hub_remote_children is off on this desktop')
    if (this.deps.statusOf(machineId) !== 'connected')
      throw new HubRemoteCallError('not_connected', `${name} is not connected`)
    const existing = this.clients.get(machineId)
    if (existing) return existing
    const url = this.deps.urlOf(machineId)
    if (!url) throw new HubRemoteCallError('not_connected', `${name} is not connected`)
    const client = this.open(machineId, name, url, this.deps.tokenOf(machineId))
    this.clients.set(machineId, client)
    return client
  }

  private open(machineId: string, name: string, url: string, token: string | null): Client {
    const update = `update the backend on ${name}`
    if (!token) {
      // A backend from before the token cannot narrow a session to hub.
      return { transport: null, ready: Promise.resolve(update), problem: update }
    }
    const transport = new WsTransport(
      `${url}/?auth=frame`,
      // The outer call timeout fires first, with the machine's name.
      this.callTimeoutMs + 1_000,
      {},
      { session: token, scopes: [...HUB_REMOTE_AUTH_SCOPES] },
      this.deps.createSocket ?? ((u) => new WebSocket(u) as unknown as TransportSocket),
    )
    let settle: (problem: string | null) => void = () => {}
    const client: Client = {
      transport,
      ready: new Promise((resolve) => (settle = resolve)),
      problem: null,
    }
    let granted = false
    const refuse = (problem: string, why: string): void => {
      if (client.problem) return
      log.warn(`hub client refused machine ${machineId}: ${why}`)
      client.problem = problem
      settle(problem)
      transport.onStateChange = null
      transport.close()
    }
    transport.onAuthed = (scopes) => {
      if (isHubAuthGrant(scopes)) granted = true
      else refuse(update, `granted ${scopes.length} scopes other than hub only`)
    }
    transport.onBackendReady = () => {
      if (client.problem) return
      if (!granted) return refuse(update, 'ready before a hub grant')
      if (transport.supportsCapability(HUB_REMOTE_CAPABILITY) !== true)
        return refuse(update, `no ${HUB_REMOTE_CAPABILITY} capability`)
      settle(null)
    }
    transport.onStateChange = (state) => {
      if (state !== 'closed' || client.problem) return
      refuse(
        transport.authRejected
          ? `${name} refused this desktop's token; connect it again`
          : `${name} closed the hub client`,
        transport.authRejected ? 'token refused' : 'closed',
      )
    }
    for (const event of HUB_REMOTE_EVENTS) {
      transport.on(event, (...args: unknown[]) => {
        for (const fn of this.listeners.get(event) ?? []) {
          try {
            fn(machineId, ...args)
          } catch (err) {
            log.warn(`a ${event} listener threw`, err)
          }
        }
      })
    }
    return client
  }

  private close(machineId: string): void {
    const client = this.clients.get(machineId)
    if (!client) return
    this.clients.delete(machineId)
    if (!client.transport) return
    client.transport.onStateChange = null
    client.transport.close()
  }

  private nameOf(machineId: string): string {
    return this.deps.machines().find((m) => m.id === machineId)?.name ?? machineId
  }
}
