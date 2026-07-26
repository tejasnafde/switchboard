/**
 * Saved backends + live client pool. Configs persist via AsyncStorage; the
 * WsTransport/SwitchboardClient instances are runtime-only (module-level map,
 * never serialized). One client per backend - VM-direct (tailnet) and
 * Mac-relay endpoints look identical from here, they're just ws:// URLs.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WsTransport } from '@shared/ws-transport'
import { createLogger } from '@shared/logger'
import { SwitchboardClient } from '../lib/api'
import { IapTransport } from '../lib/iap-transport'
import { useChatStore } from './chat'

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
  /** ws://host:port - token travels separately, appended at dial time. */
  url: string
  token?: string
}

export interface IapConnectionConfig {
  id: string
  label: string
  kind: 'iap'
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
}

export const useConnectionsStore = create<ConnectionsState>()(
  persist(
    (set, get) => ({
      configs: [],
      status: {},

      addConnection: (config) => set((s) => ({ configs: [...s.configs, config] })),

      updateConnection: (id, patch) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? ({ ...c, ...patch } as ConnectionConfig) : c)),
        })),

      removeConnection: (id) => {
        get().disconnect(id)
        set((s) => {
          const status = { ...s.status }
          delete status[id]
          return { configs: s.configs.filter((c) => c.id !== id), status }
        })
      },

      connect: (id) => {
        const config = get().configs.find((c) => c.id === id)
        if (!config || clients.has(id)) return
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
          const wsClient = SwitchboardClient.overWs(config.url, config.token)
          const transport = wsClient.transport as WsTransport
          // Status rides the transport's own lifecycle - open/reconnect/terminal
          // all reflect live, so a dropped tunnel can't leave a stale green dot.
          transport.onStateChange = (state) => {
            if (state === 'connected') get().setStatus(id, 'connected')
            else if (state === 'reconnecting') get().setStatus(id, 'connecting')
            // authRejected = server said 4001 (bad token): error, not merely off.
            else get().setStatus(id, transport.authRejected ? 'error' : 'disconnected')
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
      partialize: (s) => ({ configs: s.configs }),
    },
  ),
)

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
    return null
  }
}
