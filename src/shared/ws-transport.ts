/**
 * Client Transport over a WebSocket (vs Electron IPC). Uses the global
 * WebSocket so it needs no dependency. Frames before 'open' queue; in-flight
 * invokes reject on close. An unexpected close re-dials the same URL with
 * capped exponential backoff (tunnel blips heal in place - subscriptions and
 * queued frames survive). Only a deliberate close() or a server auth rejection
 * is terminal; a long outage keeps retrying at the cap.
 *
 * Three mobile-driven behaviours live here:
 *
 *  - **Resume.** On every open the transport sends `hello { since, epoch }` and
 *    the server replays the `evt` frames it missed. Live frames arriving before
 *    the replay are held back, so the listener still sees them in order.
 *  - **Heartbeat.** The server pings; silence past a threshold means a
 *    half-open socket (radio off, NAT rebind) and forces a re-dial instead of
 *    waiting for a 30s invoke timeout to notice.
 *  - **Classification.** A close is `transient` (retry forever) or `blocked`
 *    (a verdict - stop and wait for the user to change something), so a UI can
 *    say "token rejected" instead of spinning on "connecting".
 */
import { encodeFrame, decodeFrame, type WsFrame } from './ws-protocol'
import { reconnectDelay } from './backoff'
import type { Transport } from './transport'
import { createLogger } from './logger'

const log = createLogger('ws-transport')

const DEFAULT_TIMEOUT_MS = 30_000
/** provider:* channels can run long (OpenCode cold boot, providerInstances TEST
 *  shelling out to a CLI) - give them a generous timeout instead of the default. */
const PROVIDER_TIMEOUT_MS = 200_000

/** Re-dial backoff: 500ms doubling to a 5s cap. Past the budget we keep going
 *  but start logging, so a long outage is visible without being terminal. */
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 5_000
const RECONNECT_BUDGET_MS = 60_000
/** Frames queued while disconnected (pre-open or mid-reconnect) beyond this
 *  bound are rejected/dropped instead of piling up unbounded. */
const MAX_QUEUED_FRAMES = 100

/**
 * No frame of any kind for this long means the socket is half-open. The server
 * pings every 15s, so this is two missed pings plus slack - long enough that a
 * brief radio stall does not churn the connection, short enough that the user
 * sees "reconnecting" rather than a dead screen.
 */
const SILENCE_LIMIT_MS = 40_000
const WATCHDOG_INTERVAL_MS = 5_000

export interface WsReconnectOptions {
  baseMs?: number
  capMs?: number
  budgetMs?: number
}

/** WsHost's auth rejection close code - a server verdict, not a blip. */
const CLOSE_UNAUTHORIZED = 4001

export type WsTransportState = 'connected' | 'reconnecting' | 'closed'

/**
 * Why the connection is not up.
 *
 *  - `transient` - network, timeout, tunnel blip. Retrying is the right answer
 *    and the user has nothing to fix.
 *  - `blocked` - the server made a decision (bad token). Retrying loops against
 *    a rejection forever; something has to change first.
 */
export type WsCloseReason = 'transient' | 'blocked'

export function classifyCloseCode(code: number | null): WsCloseReason {
  return code === CLOSE_UNAUTHORIZED ? 'blocked' : 'transient'
}

interface PendingInvoke {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** True once the frame actually went over a socket - a socket close loses
   *  its response for good. Queued invokes stay pending across a re-dial. */
  sent: boolean
}

interface QueuedFrame {
  encoded: string
  /** Set for invoke frames so a flush can mark their pending entry as sent. */
  id?: number
}

/** Drop trailing `undefined` args before serializing - JSON.stringify would
 *  otherwise turn them into `null`, diverging from Electron structured-clone
 *  (which drops them, so callee default params still apply). */
function stripTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end)
}

export class WsTransport implements Transport {
  private ws!: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, PendingInvoke>()
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly outbox: QueuedFrame[] = []
  private open = false
  /** Terminal: deliberate close() or auth rejection. Never unset. */
  private closed = false
  /** Set when the server closed us with 4001 - surfaced so UIs can say "bad token"
   *  instead of spinning on "connecting". */
  authRejected = false
  /**
   * Why the last socket died, and how many re-dials since the last success.
   *
   * A client stuck on "connecting" is otherwise indistinguishable from one that
   * connects and is dropped every time - which is exactly the case that took a
   * long time to diagnose once already.
   */
  lastCloseCode: number | null = null
  lastCloseReason: WsCloseReason = 'transient'
  redialCount = 0
  /** Optional liveness observer - fired on open / unexpected close / terminal
   *  shutdown. Assign after construction; connection stores use this instead
   *  of probing. */
  onStateChange: ((state: WsTransportState) => void) | null = null
  /**
   * Fired when the server could not replay everything we missed, so our view is
   * known-incomplete. The owner re-seeds (re-fetches the open thread) instead
   * of stitching a transcript that is quietly missing turns.
   */
  onResumeGap: (() => void) | null = null

  /** Highest `evt` sequence applied. Sent as `since` on the next open. */
  private lastSeq = 0
  /** The server process our sequence belongs to; a change means start over. */
  private epoch: string | null = null
  /** Live frames that arrived before this connection's replay landed. Held so
   *  the listener never sees a newer event before an older one. */
  private resumeHold: Array<Extract<WsFrame, { k: 'evt' }>> | null = null
  private lastFrameAt = 0
  /**
   * Set once the backend proves it speaks the heartbeat, by sending a `ping` or
   * a `ready`. Until then the liveness checks stay disarmed, because an older
   * backend's silence is normal rather than fatal.
   */
  private peerSendsHeartbeat = false
  /** The socket already routed through onSocketDead. forceReconnect drives that
   *  path by hand, and the real 'close' event then arrives for the same socket. */
  private deadSocket: WebSocket | null = null
  /**
   * Whether the device believes it has a network. Defaults true so a caller
   * that never reports stays on the old always-retry behaviour.
   */
  private online = true
  /**
   * In-band credential. When set, the transport authenticates with an `auth`
   * frame instead of putting a token in the URL.
   */
  private auth: { session?: string; pairing?: string; label?: string } | null = null
  /**
   * Called when a pairing exchange mints a session token. This is the only
   * moment that token is transmitted, so the owner must persist it here or the
   * device has to pair again.
   */
  onSessionIssued: ((session: string) => void) | null = null
  private readonly watchdog: ReturnType<typeof setInterval>

  private reconnecting = false
  private reconnectAttempt = 0
  private reconnectStartedAt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reconnectBaseMs: number
  private readonly reconnectCapMs: number
  private readonly reconnectBudgetMs: number

  constructor(
    readonly url: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    reconnect: WsReconnectOptions = {},
    auth: { session?: string; pairing?: string; label?: string } | null = null,
  ) {
    this.auth = auth
    this.reconnectBaseMs = reconnect.baseMs ?? RECONNECT_BASE_MS
    this.reconnectCapMs = reconnect.capMs ?? RECONNECT_CAP_MS
    this.reconnectBudgetMs = reconnect.budgetMs ?? RECONNECT_BUDGET_MS
    this.watchdog = setInterval(() => this.checkSilence(), WATCHDOG_INTERVAL_MS)
    // Node keeps a bare interval alive; the renderer and RN ignore this.
    ;(this.watchdog as { unref?: () => void }).unref?.()
    this.dial()
  }

  /** True until a deliberate close() or an auth rejection - a transport
   *  mid-reconnect is still alive (its subscriptions will survive). */
  isAlive(): boolean {
    return !this.closed
  }

  /**
   * Drop a socket that has gone quiet. A half-open TCP connection reports
   * `readyState === OPEN` indefinitely, so elapsed silence is the only signal
   * available to a client that cannot send protocol-level pings.
   */
  private checkSilence(): void {
    if (this.closed || !this.open) return
    // Silence only means death if the peer would otherwise be talking. A
    // backend from before the heartbeat existed never pings, so arming this
    // against one would tear down a perfectly good idle connection every 40s
    // forever. The phone updates over OTA while the desktop it pairs with
    // updates by hand, so that skew is a normal state, not an edge case.
    if (!this.peerSendsHeartbeat) return
    if (Date.now() - this.lastFrameAt < SILENCE_LIMIT_MS) return
    log.warn('no frames for', `${SILENCE_LIMIT_MS}ms - treating socket as dead`, this.url)
    this.forceReconnect()
  }

  /**
   * Tear down the current socket and re-dial now. Used by the watchdog and by
   * a client returning to the foreground after long enough that the OS has
   * probably killed the socket without telling either end.
   */
  forceReconnect(): void {
    if (this.closed) return
    try {
      this.ws.close()
    } catch (err) {
      log.warn('forceReconnect on an already-dead socket', err)
    }
    // `close()` on a half-open socket can hang without ever firing 'close', so
    // drive the dead path directly rather than waiting for an event. The
    // socket's own 'close' may still arrive afterwards; onSocketDead is guarded
    // against running twice for one socket, or redialCount - a diagnostic that
    // has already cost a long debugging session once - would count double.
    this.onSocketDead(this.ws, null)
  }

  /**
   * Cheap liveness check for a foreground resume: round-trips a ping and
   * forces a reconnect if the socket does not answer in time.
   */
  probe(timeoutMs = 3_000): void {
    if (this.closed || !this.open) return
    // An older backend does not answer a ping, so acting on the silence would
    // reconnect on every foreground rather than only on a dead socket.
    if (!this.peerSendsHeartbeat) return
    const before = this.lastFrameAt
    this.rawSend(encodeFrame({ k: 'ping', t: Date.now() }))
    setTimeout(() => {
      if (this.closed || !this.open) return
      if (this.lastFrameAt === before) {
        log.warn('probe went unanswered, reconnecting', this.url)
        this.forceReconnect()
      }
    }, timeoutMs)
  }

  private rawSend(encoded: string): void {
    try {
      this.ws.send(encoded)
    } catch (err) {
      log.warn('send on a dead socket', err)
    }
  }

  private dial(): void {
    const sock = new WebSocket(this.url)
    this.ws = sock
    // Every handler guards on `sock === this.ws` so a superseded socket's late
    // events (a slow close from an abandoned dial) can't corrupt current state.
    sock.addEventListener('open', () => {
      if (sock !== this.ws || this.closed) return
      this.open = true
      this.lastFrameAt = Date.now()
      if (this.reconnecting) {
        log.info('reconnected', this.url)
        this.reconnecting = false
        this.reconnectAttempt = 0
      }
      this.redialCount = 0
      this.lastCloseCode = null
      // Hold live events until the replay lands, so a resumed client does not
      // see turn N+1 before the turn N it missed while disconnected.
      this.resumeHold = []
      // Before hello: the server refuses everything until this lands, and
      // ordering the two means one round trip rather than two.
      if (this.auth) this.rawSend(encodeFrame({ k: 'auth', ...this.auth }))
      // Guarded: a socket that dies between 'open' and here would otherwise
      // throw out of the listener, skipping onStateChange and the outbox flush
      // below and leaving the UI on "connecting" with this.open already true.
      this.rawSend(encodeFrame({ k: 'hello', since: this.lastSeq, epoch: this.epoch ?? undefined }))
      this.onStateChange?.('connected')
      for (const frame of this.outbox.splice(0)) {
        sock.send(frame.encoded)
        if (frame.id !== undefined) {
          const entry = this.pending.get(frame.id)
          if (entry) entry.sent = true
        }
      }
    })
    sock.addEventListener('message', (ev: MessageEvent) => {
      if (sock !== this.ws) return
      this.lastFrameAt = Date.now()
      const frame = decodeFrame(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (frame) this.dispatch(frame)
    })
    // 'close' and 'error' both funnel here. A refused connect fires only
    // 'error' on some WebSocket impls (Node 22's undici) - without this, the
    // first failed dial silently killed the whole re-dial chain. Spec-compliant
    // impls fire both for one failure, hence the settled guard.
    let settled = false
    const onDead = (ev?: CloseEvent): void => {
      if (settled) return
      settled = true
      this.onSocketDead(sock, typeof ev?.code === 'number' ? ev.code : null)
    }
    sock.addEventListener('close', onDead)
    sock.addEventListener('error', () => onDead())
  }

  private onSocketDead(sock: WebSocket, code: number | null): void {
    if (sock !== this.ws || this.closed || sock === this.deadSocket) return
    this.deadSocket = sock
    this.open = false
    this.resumeHold = null
    // In-flight invokes are genuinely lost - their responses died with the
    // socket. Queued (unsent) ones stay pending and flush after the re-dial.
    for (const [id, entry] of this.pending) {
      if (!entry.sent) continue
      clearTimeout(entry.timer)
      entry.reject(new Error('WebSocket closed'))
      this.pending.delete(id)
    }
    this.lastCloseCode = code
    this.lastCloseReason = classifyCloseCode(code)
    // 4001 is the server's auth verdict - re-dialing would loop against a
    // rejection forever. Terminal shutdown; the owner re-pairs with a new token.
    if (this.lastCloseReason === 'blocked') {
      log.error('server rejected token (4001), closing transport', this.url)
      this.authRejected = true
      this.shutdown()
      this.onStateChange?.('closed')
      return
    }
    this.redialCount++
    this.scheduleRedial()
    this.onStateChange?.('reconnecting')
  }

  /**
   * Tell the transport whether the device has a network at all.
   *
   * With the radio off, re-dialling is a guaranteed failure on a timer, which
   * costs battery and inflates the backoff so the FIRST attempt after the
   * network returns is delayed by up to the cap. Pausing instead makes that
   * reconnect immediate: coming back online is a better signal than any timer.
   */
  setOnline(online: boolean): void {
    if (this.online === online || this.closed) return
    this.online = online
    if (!online) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      return
    }
    // Only dial if we were actually waiting to. A live socket is left alone;
    // the watchdog owns deciding whether it survived.
    if (this.reconnecting && !this.open) {
      this.reconnectAttempt = 0
      this.dial()
    }
  }

  private scheduleRedial(): void {
    if (this.reconnectTimer) return
    if (!this.reconnecting) {
      this.reconnecting = true
      this.reconnectStartedAt = Date.now()
      log.warn('socket closed unexpectedly, reconnecting', this.url)
    }
    // Never terminally give up on our own: the connection manager owns
    // liveness and close()s us on real disconnects. A self-shutdown here
    // wedged permanently - the manager can sit at 'connected' (tunnel up,
    // server crash-looping) so no status edge would ever replace a transport
    // that closed itself. Keep re-dialing at the cap; log past the budget so
    // a long outage is visible.
    if (Date.now() - this.reconnectStartedAt >= this.reconnectBudgetMs && this.reconnectAttempt % 10 === 0) {
      log.error(`still reconnecting after ${Math.round((Date.now() - this.reconnectStartedAt) / 1000)}s`, this.url)
    }
    // Offline: stay in the reconnecting state but arm no timer. setOnline
    // dials the moment the network is back.
    if (!this.online) return
    this.reconnectAttempt++
    // Jittered, so a fleet of phones dropped by the same event (a laptop
    // sleeping, a wifi drop) does not come back in lockstep and hammer one
    // desktop on the same tick.
    const delay = reconnectDelay(this.reconnectAttempt, {
      baseMs: this.reconnectBaseMs,
      capMs: this.reconnectCapMs,
      jitter: 0.25,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      this.dial()
    }, delay)
  }

  /** Terminal teardown: reject everything outstanding and stop re-dialing. */
  private shutdown(): void {
    this.closed = true
    this.open = false
    this.resumeHold = null
    clearInterval(this.watchdog)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('transport closed'))
    }
    this.pending.clear()
    this.outbox.length = 0
  }

  /** Queues (or sends) a frame. Returns false when the transport is closed or
   *  the disconnected-queue bound is hit - callers surface that as they fit. */
  private write(frame: Extract<WsFrame, { ch: string }>, id?: number): boolean {
    if (this.closed) {
      log.warn('dropping frame after close', frame.ch)
      return false
    }
    const encoded = encodeFrame(frame)
    if (this.open) {
      this.ws.send(encoded)
      if (id !== undefined) {
        const entry = this.pending.get(id)
        if (entry) entry.sent = true
      }
      return true
    }
    if (this.outbox.length >= MAX_QUEUED_FRAMES) {
      log.warn('disconnected-queue bound hit, dropping frame', frame.ch)
      return false
    }
    this.outbox.push({ encoded, id })
    return true
  }

  private dispatch(frame: WsFrame): void {
    if (frame.k === 'res') {
      const entry = this.pending.get(frame.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(frame.id)
      if (frame.ok) entry.resolve(frame.result)
      else entry.reject(new Error(frame.error))
      return
    }
    if (frame.k === 'ping') {
      this.peerSendsHeartbeat = true
      this.rawSend(encodeFrame({ k: 'pong', t: frame.t }))
      return
    }
    if (frame.k === 'pong') return
    if (frame.k === 'ready') {
      this.peerSendsHeartbeat = true
      this.onReady(frame)
      return
    }
    if (frame.k === 'authed') {
      if (!frame.ok) {
        // A refusal is a verdict, not a blip. The socket close that follows
        // carries 4001 and takes the transport terminal.
        log.error('backend refused our credential', frame.error)
        return
      }
      if (frame.session) {
        // Swap the one-time pairing code for the session immediately, so a
        // reconnect before the owner has persisted it still authenticates.
        this.auth = { session: frame.session }
        this.onSessionIssued?.(frame.session)
      }
      return
    }
    if (frame.k === 'evt') {
      // A frame with a sequence is either a replay or live. Both are safe to
      // apply in arrival order once the replay has been released; before that,
      // live frames wait so ordering is preserved.
      if (this.resumeHold !== null && frame.seq !== undefined && frame.seq > this.lastSeq) {
        this.resumeHold.push(frame)
        return
      }
      this.applyEvent(frame)
    }
  }

  private onReady(frame: Extract<WsFrame, { k: 'ready' }>): void {
    const epochChanged = this.epoch !== null && this.epoch !== frame.epoch
    this.epoch = frame.epoch
    if (epochChanged || frame.gap) {
      // Either the backend restarted (our cursor indexes a sequence space that
      // no longer exists) or it had already evicted what we missed. Both mean
      // the local view is incomplete and only a re-seed can fix it.
      log.warn(epochChanged ? 'backend restarted, re-seeding' : 'replay gap, re-seeding', this.url)
      this.lastSeq = frame.seq
      this.resumeHold = null
      this.onResumeGap?.()
      return
    }
    // Everything sequenced since the socket opened waited for this marker:
    // replayed frames, and any live event the server broadcast before it got
    // round to our `hello`. Sort by sequence rather than trusting arrival
    // order, because that live event can land FIRST and would otherwise
    // advance lastSeq past the replay and drop all of it.
    const held = this.resumeHold ?? []
    this.resumeHold = null
    held.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    for (const evt of held) this.applyEvent(evt)
  }

  private applyEvent(frame: Extract<WsFrame, { k: 'evt' }>): void {
    if (frame.seq !== undefined) {
      // Duplicates are expected: a replay can overlap frames we already saw on
      // the previous socket before it died.
      if (frame.seq <= this.lastSeq) return
      this.lastSeq = frame.seq
    }
    const set = this.listeners.get(frame.ch)
    if (set) for (const fn of set) fn(...frame.args)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('transport closed'))
    const id = this.nextId++
    const timeoutMs = channel.startsWith('provider') ? PROVIDER_TIMEOUT_MS : this.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Purge a queued-but-unsent frame too: the re-dial flush would still
        // send it, making the remote execute a request the caller already saw
        // fail (double side effect for non-idempotent calls).
        const qi = this.outbox.findIndex((f) => f.id === id)
        if (qi >= 0) this.outbox.splice(qi, 1)
        reject(new Error(`invoke timed out: ${channel}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sent: false })
      if (!this.write({ k: 'req', id, ch: channel, args: stripTrailingUndefined(args) }, id)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(this.closed ? 'transport closed' : `transport queue full: ${channel}`))
      }
    })
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ k: 'snd', ch: channel, args: stripTrailingUndefined(args) })
  }

  on<A extends unknown[] = unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    const fn = handler as (...args: unknown[]) => void
    set.add(fn)
    return () => set!.delete(fn)
  }

  close(): void {
    if (this.closed) return
    this.shutdown()
    this.onStateChange?.('closed')
    try {
      this.ws.close()
    } catch (err) {
      log.warn('close() on an already-dead socket', err)
    }
  }
}
