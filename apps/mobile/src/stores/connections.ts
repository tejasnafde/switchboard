/**
 * Saved backends + live client pool. Configs persist via AsyncStorage; the
 * WsTransport/SwitchboardClient instances are runtime-only (module-level map,
 * never serialized). One client per backend - VM-direct (tailnet) and
 * Mac-relay endpoints look identical from here, they're just ws:// URLs.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SwitchboardClient } from '../lib/api'
import { useChatStore } from './chat'

export interface ConnectionConfig {
  id: string
  label: string
  /** ws://host:port - token travels separately, appended at dial time. */
  url: string
  token?: string
}

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
  updateConnection: (id: string, patch: Partial<Omit<ConnectionConfig, 'id'>>) => void
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
          configs: s.configs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
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
        const client = new SwitchboardClient(config.url, config.token)
        clients.set(id, client)
        eventUnsubs.set(
          id,
          client.onEvent((event) => useChatStore.getState().ingest(id, event)),
        )
        // Status rides the transport's own lifecycle - open/reconnect/terminal
        // all reflect live, so a dropped tunnel can't leave a stale green dot.
        client.transport.onStateChange = (state) => {
          if (state === 'connected') get().setStatus(id, 'connected')
          else if (state === 'reconnecting') get().setStatus(id, 'connecting')
          // authRejected = server said 4001 (bad token): error, not merely off.
          else get().setStatus(id, client.transport.authRejected ? 'error' : 'disconnected')
        }
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
