/**
 * Per-session backend routing. Holds one Transport per machine ('local' plus a
 * WsTransport for each connected remote) and routes each invoke/send to the
 * machine a resolver names - so a window can drive a local Claude session and a
 * remote one at the same time. on() fans out to every transport (current and
 * future) and merges their push events, since each backend only emits its own
 * sessions' events.
 *
 * With only 'local' registered and the default resolver, this is a transparent
 * pass-through - identical to talking to a single Transport.
 */
import type { Transport } from '@shared/transport'

/** Maps a call to the machine id that should serve it. Returns 'local' to stay local. */
export type MachineResolver = (channel: string, args: unknown[]) => string

/**
 * Whether a machine's `connected` status event should replace its existing
 * transport. Reconnects reuse the same tunnel port, so the URL usually hasn't
 * changed - keep the transport (it re-dials in place, preserving every push
 * subscription and queued call) instead of tearing it down for a no-op echo.
 * Replace only when there is none yet, the URL moved (port-stolen fallback),
 * or the old one terminally closed (deliberate close / reconnect budget spent).
 */
export function shouldReplaceTransport(
  existing: { url: string; isAlive(): boolean } | undefined,
  url: string,
): boolean {
  if (!existing) return true
  return existing.url !== url || !existing.isAlive()
}

interface Fanout {
  channel: string
  /** Source-aware handler - always takes the emitting machine id first. */
  handler: (machineId: string, ...args: unknown[]) => void
  offs: Map<string, () => void>
}

export class TransportRouter implements Transport {
  private readonly transports = new Map<string, Transport>()
  private readonly fanouts = new Set<Fanout>()

  constructor(
    local: Transport,
    private readonly resolve: MachineResolver = () => 'local',
  ) {
    this.transports.set('local', local)
  }

  register(machineId: string, transport: Transport): void {
    if (this.transports.has(machineId)) return
    this.transports.set(machineId, transport)
    for (const f of this.fanouts) {
      f.offs.set(machineId, transport.on(f.channel, (...args: unknown[]) => f.handler(machineId, ...args)))
    }
  }

  unregister(machineId: string): void {
    if (machineId === 'local' || !this.transports.has(machineId)) return
    for (const f of this.fanouts) {
      f.offs.get(machineId)?.()
      f.offs.delete(machineId)
    }
    this.transports.delete(machineId)
  }

  private pick(channel: string, args: unknown[]): Transport {
    const id = this.resolve(channel, args)
    const t = this.transports.get(id)
    if (t) return t
    if (id !== 'local') throw new Error('machine not connected: ' + id)
    return this.transports.get('local')!
  }

  invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    // pick() can throw synchronously (unregistered machine); invoke's contract
    // is a Promise, so surface that as a rejection rather than a thrown error.
    try {
      return this.pick(channel, args).invoke<T>(channel, ...args)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** Invoke on a named machine directly, bypassing the resolver (e.g. to scan a remote on connect). */
  invokeOn<T>(machineId: string, channel: string, ...args: unknown[]): Promise<T> {
    const t = this.transports.get(machineId)
    if (t) return t.invoke<T>(channel, ...args)
    if (machineId !== 'local') return Promise.reject(new Error('machine not connected: ' + machineId))
    return this.transports.get('local')!.invoke<T>(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    this.pick(channel, args).send(channel, ...args)
  }

  on<A extends unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    return this.onWithSource<A>(channel, (_machineId, ...args) => handler(...args))
  }

  /** Like on(), but the handler also receives the emitting machine's id
   *  ('local' or a remote's) - two machines can emit the same threadId. */
  onWithSource<A extends unknown[]>(
    channel: string,
    handler: (machineId: string, ...args: A) => void,
  ): () => void {
    const h = handler as (machineId: string, ...args: unknown[]) => void
    const offs = new Map<string, () => void>()
    for (const [id, t] of this.transports) {
      offs.set(id, t.on(channel, (...args: unknown[]) => h(id, ...args)))
    }
    const fanout: Fanout = { channel, handler: h, offs }
    this.fanouts.add(fanout)
    return () => {
      for (const off of fanout.offs.values()) off()
      this.fanouts.delete(fanout)
    }
  }
}
