/**
 * Server BackendHost over ws-protocol: the same registerX handlers that run
 * under ElectronIpcHost run here unchanged.
 *
 * Beyond dispatch it owns three things the phone case forced on us:
 *
 *  - a monotonic sequence on every replayable `evt`, plus a bounded buffer, so
 *    a client that was disconnected can ask for what it missed;
 *  - a per-process `epoch`, so a restarted server tells clients to start over
 *    rather than letting a stale high cursor swallow every new event;
 *  - an application-level heartbeat, because a mobile socket dies without a
 *    FIN and both ends otherwise stay "connected" until a request times out.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { encodeFrame, decodeFrame, isReplayableEventChannel, type WsFrame } from '@shared/ws-protocol'
import { EventReplayBuffer } from '@shared/event-replay-buffer'
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'

const log = createLogger('backend:ws-host')

/**
 * Largest single frame a client may send.
 *
 * `ws` defaults to 100 MB, which on a listener bound to every interface lets
 * one connection pin memory before any of our code sees the frame.
 *
 * 64 MB rather than something tighter because the DESKTOP composer has no
 * total-turn bound: `ChatInput` caps a single image at 20 MB raw, which is
 * ~27 MB once base64'd, and allows several per turn. Over a remote WsHost a
 * frame past the cap is closed with 1009, which the user sees as a reconnect
 * and a lost turn with no explanation. The mobile client is not the problem
 * here - it already bounds a turn at 12 MB (`lib/images.ts`). Giving the
 * desktop the same wire budget is the real fix; until then this stays generous
 * enough not to break a normal paste.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Ping cadence. Short enough that a dead phone socket is noticed while the
 *  user is still looking at the screen, long enough to be free on a radio. */
export const HEARTBEAT_INTERVAL_MS = 15_000
/** Miss this many consecutive pings and the socket is presumed dead. */
const HEARTBEAT_MISS_LIMIT = 2

/** Constant-time token compare; length mismatch short-circuits (length leaks anyway). */
function tokenMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface ClientState {
  missedPings: number
  /**
   * Set once this client has answered a ping. Until it has, missed pings are
   * not acted on: a client from before the heartbeat existed never sends
   * `pong`, and terminating it after 30s would break a working connection.
   * A phone updates over OTA independently of the desktop it pairs with, so
   * that skew is routine.
   */
  sawPong: boolean
}

export class WsHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  private readonly clients = new Map<WebSocket, ClientState>()
  private readonly replay = new EventReplayBuffer()
  private readonly heartbeat: ReturnType<typeof setInterval>
  /** Identifies this process's sequence space. Regenerated on every start. */
  readonly epoch = randomUUID()
  private seq = 0

  /**
   * `token` (SWITCHBOARD_TOKEN on the server) gates connections when set:
   * clients dial `ws://host:port/?token=<token>`. Unset preserves the
   * loopback/SSH-tunnel trust model (no in-band auth).
   */
  constructor(
    private readonly wss: WebSocketServer,
    token?: string,
  ) {
    this.wss.on('connection', (socket, req: IncomingMessage) => {
      if (token) {
        let presented: string | null = null
        try {
          presented = new URL(req.url ?? '/', 'ws://localhost').searchParams.get('token')
        } catch (err) {
          log.warn('unparseable upgrade url', err)
        }
        if (!tokenMatches(token, presented)) {
          log.warn(`rejected connection with ${presented === null ? 'missing' : 'bad'} token`)
          socket.close(4001, 'unauthorized')
          return
        }
      }
      this.clients.set(socket, { missedPings: 0, sawPong: false })
      log.info(`client connected (${this.clients.size} total)`)
      socket.on('message', (data) => this.onMessage(socket, data.toString()))
      socket.on('close', () => {
        this.clients.delete(socket)
        log.info(`client disconnected (${this.clients.size} total)`)
      })
      socket.on('error', (err) => log.warn(`socket error: ${err.message}`))
    })

    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS)
    // A bare interval keeps a headless Node server alive with nothing to do.
    this.heartbeat.unref?.()
  }

  /**
   * Ping every client and drop the ones that stopped answering. `terminate` and
   * not `close`: a half-open socket never completes a closing handshake, which
   * is the exact state this exists to clear.
   */
  private sweep(): void {
    const frame = encodeFrame({ k: 'ping', t: Date.now() })
    for (const [socket, state] of this.clients) {
      if (socket.readyState !== socket.OPEN) continue
      if (state.sawPong && state.missedPings >= HEARTBEAT_MISS_LIMIT) {
        log.warn('client missed heartbeats, terminating socket')
        this.clients.delete(socket)
        socket.terminate()
        continue
      }
      state.missedPings++
      socket.send(frame)
    }
  }

  private async onMessage(socket: WebSocket, data: string): Promise<void> {
    const frame = decodeFrame(data)
    if (!frame) {
      log.warn('dropped unparseable frame')
      return
    }
    if (frame.k === 'req') {
      const handler = this.handlers.get(frame.ch)
      if (!handler) {
        this.reply(socket, { k: 'res', id: frame.id, ok: false, error: `no handler: ${frame.ch}` })
        return
      }
      try {
        const result = await handler(...frame.args)
        this.reply(socket, { k: 'res', id: frame.id, ok: true, result })
      } catch (err) {
        this.reply(socket, { k: 'res', id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    } else if (frame.k === 'snd') {
      const fns = this.listeners.get(frame.ch)
      if (fns) for (const fn of fns) fn(...frame.args)
    } else if (frame.k === 'hello') {
      this.onHello(socket, frame)
    } else if (frame.k === 'pong') {
      const state = this.clients.get(socket)
      if (state) {
        state.missedPings = 0
        state.sawPong = true
      }
    } else if (frame.k === 'ping') {
      this.reply(socket, { k: 'pong', t: frame.t })
    }
  }

  /**
   * Answer a resume request. A client from a previous process (or one asking
   * for a cursor we have already evicted) is told `gap` so it re-seeds rather
   * than assuming the replay was complete.
   */
  private onHello(socket: WebSocket, frame: Extract<WsFrame, { k: 'hello' }>): void {
    const requested = frame.since ?? 0
    const sameEpoch = frame.epoch === this.epoch
    // A cursor from another process indexes a sequence space that no longer
    // exists, so replaying against it would deliver the wrong events entirely.
    // `requested`, not the zeroed cursor: a cross-epoch client HAS lost events,
    // and reporting otherwise would let it stitch a broken transcript.
    const result = sameEpoch && requested > 0 ? this.replay.since(requested) : { frames: [], gap: requested > 0 }
    // Replay BEFORE the ready marker. The client holds live frames only until
    // ready lands, so anything sent after it is applied out of order and then
    // swallowed by the duplicate guard - which silently loses exactly the
    // events this mechanism exists to recover.
    //
    // Nothing is sent on a gap: the client discards its cursor and re-seeds, so
    // shipping up to the whole buffer would be pure waste on a metered link.
    if (!result.gap) {
      for (const encoded of result.frames) {
        if (socket.readyState === socket.OPEN) socket.send(encoded)
      }
    }
    this.reply(socket, {
      k: 'ready',
      epoch: this.epoch,
      seq: this.seq,
      replayed: result.gap ? 0 : result.frames.length,
      gap: result.gap,
    })
    if (result.frames.length > 0 || result.gap) {
      log.info(
        `client resumed from ${requested}: ${result.gap ? 'gap, told to re-seed' : `replayed ${result.frames.length}`}`,
      )
    }
  }

  private reply(socket: WebSocket, frame: WsFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame))
  }

  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }

  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    const fns = this.listeners.get(channel) ?? []
    fns.push(fn as (...args: unknown[]) => void)
    this.listeners.set(channel, fns)
  }

  emit(channel: string, ...args: unknown[]): void {
    const replayable = isReplayableEventChannel(channel)
    // Only replayable channels consume sequence numbers. Terminal output would
    // otherwise advance the counter thousands of times a second and make every
    // resume look like a gap.
    const seq = replayable ? ++this.seq : undefined
    const encoded = encodeFrame({ k: 'evt', ch: channel, args, seq })
    if (replayable && seq !== undefined) this.replay.push(seq, encoded)
    // Broadcast to everyone immediately, including a client whose `hello` is
    // still in flight. Gating on hello would starve an older build that never
    // sends one; the client instead holds live frames until its replay lands,
    // so ordering is fixed on the side that can tell the difference.
    for (const socket of this.clients.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(encoded)
    }
  }

  /** Stop the heartbeat. Call when the host is torn down for good. */
  dispose(): void {
    clearInterval(this.heartbeat)
  }
}
