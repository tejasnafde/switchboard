/**
 * Saved backends + live client pool. Configs persist via AsyncStorage; the
 * WsTransport/SwitchboardClient instances are runtime-only (module-level map,
 * never serialized). One client per backend - VM-direct (tailnet) and
 * Mac-relay endpoints look identical from here, they're just ws:// URLs.
 *
 * Pairing tokens are the exception: they live in the OS keystore (lib/secrets)
 * and are rehydrated into the in-memory configs on start, so the persisted blob
 * never contains a credential that grants a remote shell.
 */
import { AppState, type AppStateStatus } from 'react-native'
import * as Network from 'expo-network'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WsTransport } from '@shared/ws-transport'
import { createLogger } from '@shared/logger'
import { SwitchboardClient } from '../lib/api'
import { IapTransport } from '../lib/iap-transport'
import { foregroundAction } from '../lib/appLifecycle'
import {
  deleteConnectionToken,
  loadConnectionSession,
  loadConnectionToken,
  migrateTokensToKeystore,
  saveConnectionSession,
  saveConnectionToken,
} from '../lib/secrets'
import { useChatStore } from './chat'
import { drain as drainOutbox } from './outbox'

const log = createLogger('store:connections')

/**
 * Supplies a current Google OAuth access token (cloud-platform scope) for IAP
 * connections. Set once by the auth layer at startup; kept as a getter so the
 * store never holds a stale token across a silent refresh.
 */
let getGoogleAccessToken: (() => string | null) | null = null
export function setGoogleTokenProvider(fn: () => string | null): void {
  getGoogleAccessToken = fn
}

/**
 * Two ways to reach a backend:
 *   'ws'  - a ws:// URL (LAN, tailnet, or a tunnel someone else set up)
 *   'iap' - a work VM through Google IAP, which needs no inbound reachability
 *           at all and works from any network with the laptop closed
 */
export interface WsConnectionConfig {
  id: string
  label: string
  kind: 'ws'
  /** ws://host:port - credentials travel separately, never in this string. */
  url: string
  /**
   * Legacy shared secret, appended to the dial URL.
   *
   * Kept only so a phone paired before device sessions existed keeps working.
   * It grants everything, cannot be revoked without cutting off every other
   * device, and rides in the query string. A re-pair replaces it with
   * `session` and it is then cleared.
   */
  token?: string
  /** Per-device session token, sent in an auth frame. Held in the keystore. */
  session?: string
  /** One-time code from the QR, exchanged for `session` on first connect. */
  pairing?: string
}

export interface IapConnectionConfig {
  id: string
  label: string
  kind: 'iap'
  /** Present for shape parity with the ws config so credential handling can
   *  stay kind-agnostic. IAP reaches TcpHost, which has its own auth frame and
   *  does not yet mint device sessions. */
  session?: string
  pairing?: string
  project: string
  zone: string
  instance: string
  /** VM port running TcpHost (the server's TCP_PORT). */
  port: number
  /** SWITCHBOARD_TOKEN on that VM. */
  token?: string
}

export type ConnectionConfig = WsConnectionConfig | IapConnectionConfig

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Runtime-only: clients live outside the store so persist never touches them. */
const clients = new Map<string, SwitchboardClient>()
const eventUnsubs = new Map<string, () => void>()

export function getClient(connectionId: string): SwitchboardClient | undefined {
  return clients.get(connectionId)
}

interface ConnectionsState {
  configs: ConnectionConfig[]
  /** Runtime status per connection id (rebuilt on app start, not persisted). */
  status: Record<string, ConnectionStatus>
  addConnection: (config: ConnectionConfig) => void
  updateConnection: (id: string, patch: Partial<ConnectionConfig>) => void
  removeConnection: (id: string) => void
  connect: (id: string) => void
  disconnect: (id: string) => void
  setStatus: (id: string, status: ConnectionStatus) => void
  /** Why a connection is not live, keyed by id. Cleared on success. */
  detail: Record<string, string>
}

export const useConnectionsStore = create<ConnectionsState>()(
  persist(
    (set, get) => ({
      configs: [],
      status: {},
      detail: {},

      addConnection: (config) => {
        // The in-memory config keeps the token so a connect() on the next line
        // works; only the persisted copy is stripped.
        void rememberToken(config.id, config.token)
        set((s) => ({ configs: [...s.configs, config] }))
      },

      updateConnection: (id, patch) => {
        if ('token' in patch) void rememberToken(id, patch.token)
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? ({ ...c, ...patch } as ConnectionConfig) : c)),
        }))
      },

      removeConnection: (id) => {
        get().disconnect(id)
        void deleteConnectionToken(id)
        set((s) => {
          const status = { ...s.status }
          delete status[id]
          return { configs: s.configs.filter((c) => c.id !== id), status }
        })
      },

      connect: (id) => {
        const config = get().configs.find((c) => c.id === id)
        if (!config) return
        const existing = clients.get(id)
        if (existing) {
          // A dead client still occupies the map, so a plain `has` check made
          // the Connect button a silent no-op: the user had to Disconnect and
          // Connect again to revive a transport that had given up. Replace it.
          if (existing.transport.isAlive?.() !== false) return
          get().disconnect(id)
        }
        get().setStatus(id, 'connecting')

        let client: SwitchboardClient
        if (config.kind === 'iap') {
          // Needs a fresh Google access token; the caller must have signed in.
          const accessToken = getGoogleAccessToken?.()
          if (!accessToken) {
            get().setStatus(id, 'error')
            log.warn('iap connection needs a Google sign-in first', config.label)
            return
          }
          const transport = new IapTransport({
            target: {
              project: config.project,
              zone: config.zone,
              instance: config.instance,
              port: config.port,
            },
            accessToken,
            backendToken: config.token,
          })
          transport.onStateChange = (state) =>
            get().setStatus(id, state === 'connected' ? 'connected' : 'disconnected')
          client = new SwitchboardClient(transport)
        } else {
          // Prefer the device session; fall back to the shared token only for
          // a connection paired before sessions existed.
          const auth =
            config.session || config.pairing
              ? { session: config.session, pairing: config.pairing, label: config.label }
              : null
          const wsClient = SwitchboardClient.overWs(config.url, config.token, auth)
          const transport = wsClient.transport as WsTransport
          // The minted session is transmitted exactly once, in reply to the
          // pairing code. Persisting it here is what makes the code one-time
          // rather than a credential the phone keeps re-presenting.
          transport.onSessionIssued = (session) => {
            log.info('received a device session, retiring the pairing code', config.label)
            void saveConnectionSession(id, session)
            // The shared token is cleared here: this connection now has a
            // credential of its own, and keeping the old one alive would
            // preserve exactly the blast radius the session removes.
            void saveConnectionToken(id, undefined)
            get().updateConnection(id, { session, pairing: undefined, token: undefined })
          }
          // The backend could not replay everything we missed, so the cached
          // feed for this backend has a hole in it. Drop it and re-seed rather
          // than showing a transcript that is quietly missing turns.
          transport.onResumeGap = () => {
            log.warn('backend could not replay missed events, re-seeding', config.label)
            useChatStore.getState().invalidateConnection(id)
          }
          // Status rides the transport's own lifecycle - open/reconnect/terminal
          // all reflect live, so a dropped tunnel can't leave a stale green dot.
          transport.onStateChange = (state) => {
            if (state === 'connected') {
              set((s) => ({ detail: { ...s.detail, [id]: '' } }))
              get().setStatus(id, 'connected')
              // A backend coming up is the event the queue is waiting for.
              void drainOutbox()
            } else if (state === 'reconnecting') {
              // A socket that opens and is dropped looks identical to one that
              // never opens, unless the close code is shown.
              const why = transport.lastCloseCode
                ? `dropped (${transport.lastCloseCode}), retry ${transport.redialCount}`
                : `retry ${transport.redialCount}`
              set((s) => ({ detail: { ...s.detail, [id]: why } }))
              get().setStatus(id, 'connecting')
            } else {
              set((s) => ({
                detail: {
                  ...s.detail,
                  [id]: transport.authRejected ? 'token rejected - re-pair' : 'offline',
                },
              }))
              // authRejected = server said 4001 (bad token): error, not merely off.
              get().setStatus(id, transport.authRejected ? 'error' : 'disconnected')
            }
          }
          client = wsClient
        }

        clients.set(id, client)
        eventUnsubs.set(
          id,
          client.onEvent((event) => useChatStore.getState().ingest(id, event)),
        )
      },

      disconnect: (id) => {
        eventUnsubs.get(id)?.()
        eventUnsubs.delete(id)
        clients.get(id)?.close()
        clients.delete(id)
        get().setStatus(id, 'disconnected')
      },

      setStatus: (id, status) => set((s) => ({ status: { ...s.status, [id]: status } })),
    }),
    {
      name: 'sb-connections',
      storage: createJSONStorage(() => AsyncStorage),
      // Tokens are deliberately absent from the persisted shape - they live in
      // the keystore and are merged back in by the rehydration below.
      //
      // Except where the keystore refused the write. Stripping those would
      // leave the token in neither store, and the next launch would dial with
      // nothing and be told 4001. A token in local storage is worse than one in
      // the keystore; a token nowhere is worse than both.
      partialize: (s) => ({
        configs: s.configs.map((c) =>
          keystoreFailures.has(c.id)
            ? c
            : ({ ...c, token: undefined, session: undefined, pairing: undefined } as ConnectionConfig),
        ),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          resolveSecrets()
          return
        }
        void hydrateTokens(state.configs).then(() => resolveSecrets())
      },
    },
  ),
)

/**
 * Connections whose token the keystore refused. Their tokens stay in the
 * persisted blob, because the alternative is losing them entirely.
 */
const keystoreFailures = new Set<string>()

/**
 * Write a token to the keystore, and remember if that failed so `partialize`
 * keeps the persisted copy instead of stripping the only remaining one.
 */
async function rememberToken(id: string, token: string | undefined): Promise<void> {
  if (await saveConnectionToken(id, token)) keystoreFailures.delete(id)
  else keystoreFailures.add(id)
}

let resolveSecrets: () => void = () => undefined
/**
 * Resolves once pairing tokens have been read out of the keystore and merged
 * into the in-memory configs. Dialling before this would present no token and
 * be rejected with 4001, which reads to the user as "wrong token" rather than
 * "not loaded yet".
 */
export const secretsReady = new Promise<void>((resolve) => {
  resolveSecrets = resolve
})

/**
 * Merge keystore tokens into the rehydrated configs, migrating any that an
 * older build left inside the persisted blob.
 */
async function hydrateTokens(configs: ConnectionConfig[]): Promise<void> {
  try {
    const { failed } = await migrateTokensToKeystore(configs)
    for (const id of failed) keystoreFailures.add(id)
    const loaded = await Promise.all(
      configs.map(async (config) => ({
        id: config.id,
        token: config.token ?? (await loadConnectionToken(config.id)),
        session: config.session ?? (await loadConnectionSession(config.id)),
      })),
    )
    const byId = new Map(loaded.map((entry) => [entry.id, entry]))
    useConnectionsStore.setState((s) => ({
      // Merge on presence, not value. Pairing runs on another screen and is not
      // gated on this, so a connection added during the keystore reads is
      // absent from `byId` - assigning its `get` result would wipe the token
      // the user just scanned.
      configs: s.configs.map((c) => {
        const entry = byId.get(c.id)
        return entry ? ({ ...c, token: entry.token, session: entry.session } as ConnectionConfig) : c
      }),
    }))
    // Rewriting state re-persists through partialize, which is what drops the
    // tokens a legacy blob was carrying.
  } catch (err) {
    log.warn('token hydration failed; connections may need re-pairing', err)
  }
}

/**
 * Keep connections honest across app suspension. Installed once from App.tsx.
 *
 * The OS suspends sockets without a close frame, so a returning user otherwise
 * stares at a live-looking screen backed by a dead connection until something
 * times out. Returns a teardown for symmetry with other listeners.
 */
/**
 * Callbacks to run when the app returns to the foreground, for state that
 * cannot survive suspension on its own. Screens register while mounted.
 */
const onForeground = new Set<() => void>()

export function onAppForeground(fn: () => void): () => void {
  onForeground.add(fn)
  return () => onForeground.delete(fn)
}

/**
 * Report the device's network state to every live transport.
 *
 * Without this the app re-dials on a timer with the radio off: guaranteed
 * failures, battery spent, and the backoff inflated so the first attempt after
 * signal returns is delayed by up to the cap. With it, losing signal parks the
 * retry and regaining it dials immediately.
 */
export function installNetworkWatch(): () => void {
  const report = (reachable: boolean): void => {
    for (const client of clients.values()) client.transport.setOnline?.(reachable)
  }
  // Seed from the current state: a launch in airplane mode should not spend
  // the first minute retrying.
  void Network.getNetworkStateAsync()
    .then((state) => report(state.isInternetReachable !== false))
    .catch((err: unknown) => log.warn('could not read the initial network state', err))
  const sub = Network.addNetworkStateListener((state) => {
    // `isInternetReachable` is undefined while the platform is still deciding.
    // Treating unknown as offline would park the queue on a working network.
    report(state.isInternetReachable !== false)
  })
  return () => sub.remove()
}

export function installLifecycleReconnect(): () => void {
  let backgroundedAt: number | null = AppState.currentState === 'background' ? Date.now() : null
  const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'background') {
      backgroundedAt = Date.now()
      return
    }
    if (next !== 'active') return
    const action = foregroundAction(backgroundedAt, Date.now())
    backgroundedAt = null
    // JS timers are suspended while backgrounded, so the open thread's viewing
    // lease has expired if the absence outlasted its TTL. Renewing here closes
    // the window in which the user is notified about the screen they are
    // looking at; ThreadScreen's own interval only covers a foregrounded app.
    onForeground.forEach((fn) => fn())
    // Retry backoffs do not tick while suspended either, so a queue parked on
    // one would otherwise wait out its full delay after the user returns.
    void drainOutbox()
    for (const [id, client] of clients) {
      const { transport } = client
      if (transport.forceReconnect || transport.probe) {
        if (action === 'reconnect') transport.forceReconnect?.()
        else transport.probe?.()
      } else {
        // IapTransport has no probe path of its own; connect() replaces it when
        // it has died, which is the only recovery it currently has.
        useConnectionsStore.getState().connect(id)
      }
    }
  })
  return () => sub.remove()
}

/** Parse a pairing payload (QR or typed): ws://host:8765?token=abc */
export function parsePairingUrl(raw: string): { url: string; token?: string } | null {
  const trimmed = raw.trim()
  if (!/^wss?:\/\//.test(trimmed)) return null
  try {
    const u = new URL(trimmed)
    const token = u.searchParams.get('token') ?? undefined
    u.search = ''
    return { url: u.toString().replace(/\/$/, ''), token }
  } catch {
    // Validator, not an error path: malformed input is the expected case and the
    // caller shows the message. Logging here would fire on every keystroke.
    return null
  }
}
