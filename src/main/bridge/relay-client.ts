/**
 * The desktop's one outbound connection to the Instinct bridge relay
 * (`wss://<relay>/connect`). It answers the relay's challenge with the device
 * key, publishes the allowed project catalog (no paths) and reconnects with
 * backoff. It records the relay's connection generation and drops every frame
 * that names another machine or an older generation. It passes the relay's
 * stop state (welcome and `control` frames) to `onControl`, and sends
 * `stop_ack` and `kill`.
 *
 * A `command` frame goes to `onCommand`, which runs the named tool and gives
 * back the body of one `result` frame. The frame is sent on the connection
 * the command arrived on; after a reconnect it is dropped, because the relay
 * drops a result of another generation. The work is run once and never again:
 * a `result_ack` the relay never sends changes nothing here, and the relay
 * accepts a late result instead.
 *
 * Only `https:` relay origins, with TLS validated by default. Plain
 * `http://127.0.0.1` or `localhost` is accepted only from the
 * `SB_BRIDGE_RELAY_ORIGIN` env var, for a local test relay.
 */
import WebSocket from 'ws'
import {
  BRIDGE_DEVICE_CAPABILITY,
  BRIDGE_WIRE_VERSION,
  DEFAULT_BRIDGE_RELAY_ORIGIN,
  bridgeError,
  bridgeHelloPayload,
  parseBridgeControl,
  type BridgeCatalogProject,
  type BridgeControl,
  type BridgeLinkState,
} from '@shared/bridge'
import { createMainLogger } from '../logger'
import type { BridgeCommandAnswer, BridgeWireError } from './command-dispatch'

const log = createMainLogger('bridge:relay')

export const MAX_RELAY_FRAME_BYTES = 64 * 1024
const AUTH_TIMEOUT_MS = 15_000
const PING_INTERVAL_MS = 30_000
const SILENCE_LIMIT_MS = 75_000
/** The exact text the relay's hibernation auto-response matches. */
const PING_FRAME = '{"type":"ping"}'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Close reasons the relay uses to refuse a device. Retried slowly, since only the operator can fix them. */
const REJECTION_CODES = new Set([
  'not_enrolled',
  'bad_signature',
  'revoked',
  'unsupported_version',
  'wrong_origin',
  'replaced',
  'invalid_frame',
  'frame_too_large',
  'relay_misconfigured',
])

export type RelayOriginResult = { ok: true; origin: string } | { ok: false; reason: string }

/** The relay origin: `SB_BRIDGE_RELAY_ORIGIN`, else the default. A path, a query or a user part is refused. */
export function resolveRelayOrigin(env: NodeJS.ProcessEnv): RelayOriginResult {
  const fromEnv = env.SB_BRIDGE_RELAY_ORIGIN?.trim()
  const raw = fromEnv || DEFAULT_BRIDGE_RELAY_ORIGIN
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'The relay origin is not a URL.' }
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    return { ok: false, reason: 'The relay origin must be a scheme and host only.' }
  if (url.protocol === 'https:') return { ok: true, origin: url.origin }
  if (url.protocol === 'http:' && fromEnv && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, origin: url.origin }
  return { ok: false, reason: 'The relay origin must use https.' }
}

export function relayConnectUrl(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/connect`
}

export interface RelaySocketHandlers {
  onMessage(text: string | null): void
  onClose(code: number, reason: string): void
  onError(err: Error): void
}

export interface RelaySocket {
  send(text: string): void
  close(code: number, reason: string): void
  terminate(): void
}

export type RelaySocketFactory = (url: string, headers: Record<string, string>, on: RelaySocketHandlers) => RelaySocket

/** Runs one validated `command` frame. Null: there is nothing to answer, so the relay hears nothing. */
export type RelayCommandRunner = (frame: Record<string, unknown>) => Promise<BridgeCommandAnswer | null>

/** Default `ws` options: no redirects, a payload cap, and TLS checked as Node does by default. */
export const RELAY_SOCKET_OPTIONS = {
  maxPayload: MAX_RELAY_FRAME_BYTES,
  handshakeTimeout: 10_000,
  followRedirects: false,
} as const

export const wsRelaySocket: RelaySocketFactory = (url, headers, on) => {
  const ws = new WebSocket(url, { ...RELAY_SOCKET_OPTIONS, headers })
  ws.on('message', (data, isBinary) => on.onMessage(isBinary ? null : data.toString()))
  ws.on('close', (code, reason) => on.onClose(code, reason.toString()))
  ws.on('error', (err) => on.onError(err))
  return {
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  }
}

export interface RelayClientStatus {
  state: Extract<BridgeLinkState, 'connecting' | 'connected' | 'retrying' | 'rejected'>
  code: string | null
  connectionGeneration: number | null
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
}

export interface RelayClientDeps {
  origin: string
  machineId: string
  sign(text: string): string
  catalog(): BridgeCatalogProject[]
  userAgent: string
  connect?: RelaySocketFactory
  timers?: Timers
  random?: () => number
  onStatus?(status: RelayClientStatus): void
  /** The relay's stop generation and kill, from the welcome and each valid `control` frame. */
  onControl?(control: BridgeControl): void
  /** The relay closed the connection with `revoked`. */
  onRevoked?(): void
  /** Runs a `command` frame for this machine. Without it a command is dropped. */
  onCommand?: RelayCommandRunner
}

type Phase = 'await_challenge' | 'await_welcome' | 'live'

export function backoffMs(attempt: number, rejected: boolean, random: () => number): number {
  const base = rejected ? 30_000 : 1_000
  const cap = rejected ? 300_000 : 60_000
  const delay = Math.min(cap, base * 2 ** Math.min(attempt, 10))
  return Math.round(delay * (0.8 + 0.4 * random()))
}

/** A catalog entry carries exactly these fields; anything else (a path) never leaves the desktop. */
export function catalogFrame(projects: BridgeCatalogProject[]): string {
  return JSON.stringify({
    type: 'catalog',
    projects: projects.map((p) => ({
      project_id: p.project_id,
      label: p.label,
      default_agent: p.default_agent,
      agents: [...p.agents],
      maximum_mode: p.maximum_mode,
    })),
  })
}

export class BridgeRelayClient {
  private socket: RelaySocket | null = null
  private phase: Phase = 'await_challenge'
  private running = false
  private attempt = 0
  private generation: number | null = null
  /** The highest generation this client was welcomed with; a lower one later is stale. */
  private highestGeneration = 0
  private lastError: string | null = null
  private lastSeen = 0
  /** The last frame of an authenticated connection, for the control lease. */
  private lastContact: number | null = null
  /** Call ids running now: a second frame for one of them is a duplicate, never a second run. */
  private readonly inFlight = new Set<string>()
  private retryTimer: unknown = null
  private authTimer: unknown = null
  private pingTimer: unknown = null
  private current: RelayClientStatus = { state: 'connecting', code: null, connectionGeneration: null }
  private readonly timers: Timers
  private readonly connectSocket: RelaySocketFactory
  private readonly random: () => number

  constructor(private readonly deps: RelayClientDeps) {
    this.timers = deps.timers ?? realTimers
    this.connectSocket = deps.connect ?? wsRelaySocket
    this.random = deps.random ?? Math.random
  }

  status(): RelayClientStatus {
    return { ...this.current }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.dial()
  }

  stop(): void {
    this.running = false
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    this.generation = null
    if (socket) {
      try {
        socket.close(1000, 'stopped')
      } catch (err) {
        log.warn('closing the relay socket failed', err instanceof Error ? err.name : 'unknown')
      }
    }
  }

  /** When the relay last spoke on an authenticated connection, or null. */
  lastContactAt(): number | null {
    return this.lastContact
  }

  /** False when there is no authenticated connection to send on. */
  sendStopAck(generation: number, state: 'confirmed' | 'unconfirmed'): boolean {
    return this.sendLive({ type: 'stop_ack', stop_generation: generation, state })
  }

  sendKill(generation: number): boolean {
    return this.sendLive({ type: 'kill', stop_generation: generation })
  }

  private sendLive(frame: { type: string; stop_generation: number; state?: string }): boolean {
    if (this.phase !== 'live' || !this.socket) return false
    if (!Number.isSafeInteger(frame.stop_generation) || frame.stop_generation < 0) return false
    this.socket.send(JSON.stringify(frame))
    return true
  }

  /** Re-sends the catalog after the allowlist changed. */
  sendCatalog(): void {
    if (this.phase !== 'live' || !this.socket) return
    this.socket.send(catalogFrame(this.deps.catalog()))
  }

  private setStatus(state: RelayClientStatus['state'], code: string | null): void {
    this.current = { state, code, connectionGeneration: state === 'connected' ? this.generation : null }
    this.deps.onStatus?.(this.status())
  }

  private clearTimers(): void {
    for (const handle of [this.retryTimer, this.authTimer, this.pingTimer])
      if (handle !== null) this.timers.clearTimeout(handle)
    this.retryTimer = this.authTimer = this.pingTimer = null
  }

  private dial(): void {
    if (!this.running) return
    this.phase = 'await_challenge'
    this.generation = null
    this.lastError = null
    this.setStatus('connecting', null)
    let socket: RelaySocket
    const owned = () => this.socket === socket
    socket = this.connectSocket(
      relayConnectUrl(this.deps.origin),
      { 'User-Agent': this.deps.userAgent },
      {
        onMessage: (text) => {
          if (owned()) this.onMessage(text)
        },
        onClose: (code, reason) => {
          if (owned()) this.onClose(code, reason)
        },
        onError: (err) => {
          // A close follows every error; only its reason is kept.
          if (owned()) log.info('relay socket error', { name: err.name, code: (err as NodeJS.ErrnoException).code })
        },
      },
    )
    this.socket = socket
    this.authTimer = this.timers.setTimeout(() => {
      if (!owned() || this.phase === 'live') return
      log.info('relay did not welcome this desktop in time')
      this.lastError = 'auth_timeout'
      socket.terminate()
    }, AUTH_TIMEOUT_MS)
  }

  private drop(code: string, frameType: string): void {
    log.info('relay frame dropped', { code, type: frameType.slice(0, 40) })
  }

  /** Closes this socket from our side; onClose then schedules the retry. */
  private fail(code: string): void {
    this.lastError = code
    log.info('relay connection refused by this desktop', { code })
    this.socket?.close(4000, code)
  }

  private onMessage(text: string | null): void {
    this.lastSeen = this.timers.now()
    if (text === null || Buffer.byteLength(text) > MAX_RELAY_FRAME_BYTES) return this.drop('invalid_frame', 'binary')
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.drop('invalid_frame', 'json')
      frame = parsed as Record<string, unknown>
    } catch {
      return this.drop('invalid_frame', 'json')
    }
    const type = typeof frame.type === 'string' ? frame.type : ''

    // A frame tagged for another machine or connection is not ours, whatever its type.
    if ('machine_id' in frame && frame.machine_id !== this.deps.machineId) return this.drop('foreign_machine', type)
    if (this.phase === 'live' && 'connection_generation' in frame && frame.connection_generation !== this.generation)
      return this.drop('stale_generation', type)
    // Anything the relay says on this authenticated connection renews the
    // control lease, a pong included: a quiet connection is still a live one.
    if (this.phase === 'live') this.lastContact = this.timers.now()

    if (type === 'pong') return
    if (type === 'challenge') return this.onChallenge(frame)
    if (type === 'welcome') return this.onWelcome(frame)
    if (type === 'error') {
      this.lastError = typeof frame.code === 'string' ? frame.code.slice(0, 64) : 'error'
      log.info('relay refused this desktop', { code: this.lastError })
      return
    }
    if (type === 'catalog_accepted') return
    if (this.phase !== 'live') return this.drop('not_authenticated', type)
    if (type === 'control') return this.onControlFrame(frame)
    if (type === 'command') return this.onCommandFrame(frame)
    if (type === 'result_ack') return this.onResultAck(frame)
    this.drop('unknown_frame', type)
  }

  /**
   * One run per call id. The generation is captured now, so an answer that
   * comes back on another connection is dropped rather than sent where the
   * relay would refuse it.
   */
  private onCommandFrame(frame: Record<string, unknown>): void {
    const generation = this.generation
    if (frame.machine_id !== this.deps.machineId || generation === null || frame.connection_generation !== generation)
      return this.drop('invalid_command', 'command')
    const run = this.deps.onCommand
    if (!run) return this.drop('commands_disabled', 'command')
    const callId = typeof frame.call_id === 'string' && frame.call_id.length > 0 ? frame.call_id : null
    if (callId === null) return this.drop('invalid_frame', 'command')
    if (this.inFlight.has(callId)) return this.drop('duplicate_call', 'command')
    this.inFlight.add(callId)
    void run(frame)
      .then((answer) => {
        if (answer) this.sendResult(answer, generation)
      })
      .catch((err: unknown) => log.warn('running a relay command failed', { err: String(err) }))
      .finally(() => this.inFlight.delete(callId))
  }

  private sendResult(answer: BridgeCommandAnswer, generation: number): void {
    if (this.phase !== 'live' || !this.socket || this.generation !== generation)
      return this.drop('stale_connection', 'result')
    const frame = {
      type: 'result',
      machine_id: this.deps.machineId,
      connection_generation: generation,
      call_id: answer.callId,
      ok: answer.ok,
      ...(answer.ok ? { result: answer.result } : { error: answer.error }),
    }
    let text = JSON.stringify(frame)
    const bytes = Buffer.byteLength(text)
    if (bytes > MAX_RELAY_FRAME_BYTES) {
      log.warn('a relay result was too large to send', { callId: answer.callId, bytes, limit: MAX_RELAY_FRAME_BYTES })
      text = JSON.stringify({
        ...frame,
        ok: false,
        result: undefined,
        error: {
          ...bridgeError(
            'internal_error',
            `The answer was ${bytes} bytes, over the ${MAX_RELAY_FRAME_BYTES} byte limit of one relay frame. ` +
              'Ask for less of it, or read the chat on this machine.',
            { call_id: answer.callId, bytes, limit: MAX_RELAY_FRAME_BYTES },
          ),
          delivered: false,
          non_delivery_confirmed: false,
        } satisfies BridgeWireError,
      })
    }
    this.socket.send(text)
  }

  /** The relay stored the answer, or says why it did not. Either way the work is never run again. */
  private onResultAck(frame: Record<string, unknown>): void {
    if (frame.stored === true) return
    log.info('the relay did not store a result', {
      reason: typeof frame.reason === 'string' ? frame.reason.slice(0, 40) : 'unknown',
    })
  }

  /** A control must name this machine and this connection; the checks above dropped any other. */
  private onControlFrame(frame: Record<string, unknown>): void {
    if (frame.machine_id !== this.deps.machineId || frame.connection_generation !== this.generation)
      return this.drop('invalid_control', 'control')
    const control = parseBridgeControl(frame)
    if (!control) return this.drop('invalid_control', 'control')
    this.deps.onControl?.(control)
  }

  private onChallenge(frame: Record<string, unknown>): void {
    if (this.phase !== 'await_challenge') return this.drop('unexpected_challenge', 'challenge')
    if (frame.wire_version !== BRIDGE_WIRE_VERSION) return this.fail('unsupported_version')
    const nonce = frame.nonce
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) return this.fail('invalid_frame')
    const signature = this.deps.sign(
      bridgeHelloPayload({ origin: this.deps.origin, machineId: this.deps.machineId, nonce }),
    )
    this.phase = 'await_welcome'
    this.socket?.send(
      JSON.stringify({
        type: 'hello',
        machine_id: this.deps.machineId,
        wire_version: BRIDGE_WIRE_VERSION,
        capabilities: [BRIDGE_DEVICE_CAPABILITY],
        relay_origin: this.deps.origin,
        signature,
      }),
    )
  }

  private onWelcome(frame: Record<string, unknown>): void {
    if (this.phase !== 'await_welcome') return this.drop('unexpected_welcome', 'welcome')
    const generation = frame.connection_generation
    if (frame.machine_id !== this.deps.machineId) return this.fail('foreign_machine')
    if (frame.wire_version !== BRIDGE_WIRE_VERSION) return this.fail('unsupported_version')
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1)
      return this.fail('invalid_frame')
    if (generation <= this.highestGeneration) return this.fail('stale_generation')
    this.highestGeneration = generation
    this.generation = generation
    this.phase = 'live'
    this.attempt = 0
    if (this.authTimer !== null) this.timers.clearTimeout(this.authTimer)
    this.authTimer = null
    this.lastContact = this.timers.now()
    log.info('connected to the bridge relay', { connectionGeneration: generation })
    this.setStatus('connected', null)
    this.sendCatalog()
    this.schedulePing()
    // An older relay sends no stop state; a malformed one is dropped, never guessed.
    if ('stop_generation' in frame || 'killed' in frame) {
      const control = parseBridgeControl(frame)
      if (control) this.deps.onControl?.(control)
      else this.drop('invalid_control', 'welcome')
    }
  }

  private schedulePing(): void {
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = null
      if (this.phase !== 'live' || !this.socket) return
      if (this.timers.now() - this.lastSeen > SILENCE_LIMIT_MS) {
        log.info('relay went silent; reconnecting')
        this.lastError = 'silent'
        this.socket.terminate()
        return
      }
      this.socket.send(PING_FRAME)
      this.schedulePing()
    }, PING_INTERVAL_MS)
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers()
    // A command still running answers into a connection that is gone; its answer is dropped there.
    this.inFlight.clear()
    this.socket = null
    this.phase = 'await_challenge'
    this.generation = null
    if (!this.running) return
    // A close reason can name numbers after its code, for example
    // "frame_too_large: 70135 bytes, limit 65536".
    const closeCode = reason.split(':')[0]
    const refusal = REJECTION_CODES.has(closeCode) ? closeCode : null
    if (reason === 'revoked') this.deps.onRevoked?.()
    const why = refusal ?? this.lastError ?? `closed_${code}`
    const rejected = refusal !== null || (this.lastError !== null && REJECTION_CODES.has(this.lastError))
    const delay = backoffMs(this.attempt, rejected, this.random)
    this.attempt += 1
    log.info('relay connection closed', { code, reason: why, retryInMs: delay })
    this.setStatus(rejected ? 'rejected' : 'retrying', why)
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      this.dial()
    }, delay)
  }
}
