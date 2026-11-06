/**
 * The desktop's one outbound connection to the Instinct bridge relay
 * (`wss://<relay>/connect`). It answers the relay's challenge with the device
 * key, publishes the allowed project catalog (no paths) and reconnects with
 * backoff. It records the relay's connection generation and drops every frame
 * that names another machine or an older generation. This PR runs no command:
 * a command frame is logged with a code and dropped.
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
  bridgeHelloPayload,
  type BridgeCatalogProject,
  type BridgeLinkState,
} from '@shared/bridge'
import { createMainLogger } from '../logger'

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
    if (type === 'pong') return

    // A frame tagged for another machine or connection is not ours, whatever its type.
    if ('machine_id' in frame && frame.machine_id !== this.deps.machineId) return this.drop('foreign_machine', type)
    if (
      this.phase === 'live' &&
      'connection_generation' in frame &&
      frame.connection_generation !== this.generation
    )
      return this.drop('stale_generation', type)

    if (type === 'challenge') return this.onChallenge(frame)
    if (type === 'welcome') return this.onWelcome(frame)
    if (type === 'error') {
      this.lastError = typeof frame.code === 'string' ? frame.code.slice(0, 64) : 'error'
      log.info('relay refused this desktop', { code: this.lastError })
      return
    }
    if (type === 'catalog_accepted') return
    if (this.phase !== 'live') return this.drop('not_authenticated', type)
    this.drop(type === 'command' ? 'commands_disabled' : 'unknown_frame', type)
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
    log.info('connected to the bridge relay', { connectionGeneration: generation })
    this.setStatus('connected', null)
    this.sendCatalog()
    this.schedulePing()
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
    this.socket = null
    this.phase = 'await_challenge'
    this.generation = null
    if (!this.running) return
    const refusal = REJECTION_CODES.has(reason) ? reason : null
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
