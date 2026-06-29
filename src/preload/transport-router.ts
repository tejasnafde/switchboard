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

interface Fanout {
  channel: string
  handler: (...args: unknown[]) => void
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
    for (const f of this.fanouts) f.offs.set(machineId, transport.on(f.channel, f.handler))
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
    return this.transports.get(id) ?? this.transports.get('local')!
  }

  invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return this.pick(channel, args).invoke<T>(channel, ...args)
  }

  /** Invoke on a named machine directly, bypassing the resolver (e.g. to scan a remote on connect). */
  invokeOn<T>(machineId: string, channel: string, ...args: unknown[]): Promise<T> {
    const t = this.transports.get(machineId) ?? this.transports.get('local')!
    return t.invoke<T>(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    this.pick(channel, args).send(channel, ...args)
  }

  on<A extends unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    const h = handler as (...args: unknown[]) => void
    const offs = new Map<string, () => void>()
    for (const [id, t] of this.transports) offs.set(id, t.on(channel, h))
    const fanout: Fanout = { channel, handler: h, offs }
    this.fanouts.add(fanout)
    return () => {
      for (const off of fanout.offs.values()) off()
      this.fanouts.delete(fanout)
    }
  }
}
