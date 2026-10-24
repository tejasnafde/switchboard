/**
 * What Home > Recents reads per machine: its chats from `app:get-projects`,
 * kept on disk so an offline machine still lists them, and this run's
 * `provider:list-sessions` reply, which is never stored.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLogger } from '@shared/logger'
import { withoutDemo } from '@shared/phone-demo/phone-demo'
import { newestSessions, sessionsFromProjects, type LiveStatuses, type RecentSession } from '../lib/home-recents'
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
  /** Drop machines that are no longer paired. */
  retain: (connectionIds: string[]) => void
}

export const useRecentsStore = create<RecentsState>()(
  persist(
    (set) => ({
      sessions: {},
      live: {},

      refresh: async (connectionId) => {
        const client = getClient(connectionId)
        if (!client) return
        const mark = statusMark()
        await Promise.all([
          client.getProjects().then(
            (projects) => set((s) => ({ sessions: { ...s.sessions, [connectionId]: sessionsFromProjects(projects) } })),
            (err: unknown) => log.warn('could not list chats for Home', err),
          ),
          client.listLiveSessions().then(
            (live) => {
              const statuses: Record<string, string> = {}
              for (const session of live)
                if (session.threadId && session.status) statuses[session.threadId] = session.status
              set((s) => ({ live: { ...s.live, [connectionId]: { mark, statuses } } }))
            },
            (err: unknown) => log.warn('could not list live sessions for Home', err),
          ),
        ])
      },

      retain: (connectionIds) =>
        set((s) => {
          const keep = new Set(connectionIds)
          if (Object.keys(s.sessions).every((id) => keep.has(id))) return {}
          return { sessions: Object.fromEntries(Object.entries(s.sessions).filter(([id]) => keep.has(id))) }
        }),
    }),
    {
      name: 'switchboard-recents',
      storage: createJSONStorage(() => AsyncStorage),
      // Statuses describe this run only, and the demo keeps nothing on the phone.
      partialize: (s) => ({
        sessions: Object.fromEntries(
          Object.entries(withoutDemo(s.sessions)).map(([id, list]) => [id, newestSessions(list, MAX_CACHED_RECENTS)]),
        ),
      }),
    },
  ),
)
