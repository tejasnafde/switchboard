/**
 * What Home > Recents reads per machine: its chats from `app:get-projects`,
 * kept on disk so an offline machine still lists them, and this run's
 * `provider:list-sessions` reply, which is never stored.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLogger } from '@shared/logger'
import type { ConversationSettledEvent } from '@shared/chat-settle'
import {
  persistedRecents,
  sessionsFromProjects,
  withSettled,
  type LiveStatuses,
  type RecentSession,
} from '../lib/home-recents'
import { statusMark } from './chat'
import { getClient } from './connections'

const log = createLogger('store:recents')

/** Per machine on disk: enough to fill Home a few pages deep while offline. */
export const MAX_CACHED_RECENTS = 50

interface RecentsState {
  sessions: Record<string, RecentSession[]>
  live: Record<string, LiveStatuses>
  /** Read one machine's chats and live statuses again. */
  refresh: (connectionId: string) => Promise<void>
  /** The machine settled or unsettled a chat: patch its row, or read the list again when none matches. */
  applySettled: (connectionId: string, event: ConversationSettledEvent) => void
  /** The machine left connected: its reply no longer describes it. */
  dropLive: (connectionId: string) => void
  /** The machine was unpaired. */
  forget: (connectionId: string) => void
}

/** The newest request per machine; an older reply that lands later is dropped. */
const requests = new Map<string, number>()
/** The request whose `getProjects` is still out, per machine. */
const projectReads = new Map<string, number>()

function without<T>(byId: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _dropped, ...rest } = byId
  return rest
}

export const useRecentsStore = create<RecentsState>()(
  persist(
    (set, get) => ({
      sessions: {},
      live: {},

      refresh: async (connectionId) => {
        const client = getClient(connectionId)
        if (!client) return
        const mark = statusMark()
        const request = (requests.get(connectionId) ?? 0) + 1
        requests.set(connectionId, request)
        const current = () => requests.get(connectionId) === request
        projectReads.set(connectionId, request)
        await Promise.all([
          client
            .getProjects()
            .finally(() => {
              if (projectReads.get(connectionId) === request) projectReads.delete(connectionId)
            })
            .then(
              (projects) => {
                if (current())
                  set((s) => ({ sessions: { ...s.sessions, [connectionId]: sessionsFromProjects(projects) } }))
              },
              (err: unknown) => log.warn('could not list chats for Home', err),
            ),
          client.listLiveSessions().then(
            (live) => {
              if (!current()) return
              const statuses: Record<string, string> = {}
              for (const session of live)
                if (session.threadId && session.status) statuses[session.threadId] = session.status
              set((s) => ({ live: { ...s.live, [connectionId]: { mark, statuses } } }))
            },
            (err: unknown) => log.warn('could not list live sessions for Home', err),
          ),
        ])
      },

      applySettled: (connectionId, event) => {
        const patched = withSettled(get().sessions[connectionId] ?? [], event.conversationId, event.settledAt)
        if (patched) set((s) => ({ sessions: { ...s.sessions, [connectionId]: patched } }))
        // No row matched, or a read that is still out would put the old settledAt back.
        if (!patched || projectReads.get(connectionId) === requests.get(connectionId)) void get().refresh(connectionId)
      },

      dropLive: (connectionId) => {
        requests.set(connectionId, (requests.get(connectionId) ?? 0) + 1)
        set((s) => (connectionId in s.live ? { live: without(s.live, connectionId) } : {}))
      },

      forget: (connectionId) => {
        requests.delete(connectionId)
        projectReads.delete(connectionId)
        set((s) => ({ sessions: without(s.sessions, connectionId), live: without(s.live, connectionId) }))
      },
    }),
    {
      name: 'switchboard-recents',
      storage: createJSONStorage(() => AsyncStorage),
      // Statuses describe this run only, and the demo keeps nothing on the phone.
      partialize: (s) => ({ sessions: persistedRecents(s.sessions, MAX_CACHED_RECENTS) }),
    },
  ),
)
