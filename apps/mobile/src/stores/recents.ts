/**
 * What Home > Recents reads per machine: its chats from `app:get-projects`,
 * kept on disk so an offline machine still lists them, and this run's
 * `provider:list-sessions` reply, which is never stored.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLogger } from '@shared/logger'
import { CHAT_SETTLE_CAPABILITY, settleBroadcastNotice, type ConversationSettledEvent } from '@shared/chat-settle'
import { CHAT_SNOOZE_CAPABILITY, isWoke, snoozeRefusalText, type ConversationSnoozedEvent } from '@shared/chat-snooze'
import {
  persistedRecents,
  sessionsFromProjects,
  withSettled,
  withSnoozeEvent,
  type LiveStatuses,
  type RecentSession,
} from '../lib/home-recents'
import { snoozedEvent, snoozeRequestFor, wokenEvent, type SnoozeChoice } from '../lib/snooze-sheet'
import { statusMark } from './chat'
import { getClient } from './connections'

const log = createLogger('store:recents')

/** Per machine on disk: enough to fill Home a few pages deep while offline. */
export const MAX_CACHED_RECENTS = 50

const NOT_CONNECTED = 'The machine is not connected'

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
  /** A snooze changed: a broadcast, or the answer to this phone's own request. */
  applySnooze: (connectionId: string, event: ConversationSnoozedEvent) => void
}

/** A settle Home offers to undo: this phone's own, or a merged PR's from a broadcast. */
export interface SettleUndo {
  connectionId: string
  id: string
  settledAt: number
  /** `settledNoticeText`: "Settled <title>", with ": PR #n merged" for a merged PR. */
  text: string
  endedSnooze?: ConversationSettledEvent['endedSnooze']
}

const settleNoticeListeners = new Set<(undo: SettleUndo) => void>()

/** A merged PR settled a chat on a connected machine. Home listens while it is shown. */
export function onMergeSettled(listener: (undo: SettleUndo) => void): () => void {
  settleNoticeListeners.add(listener)
  return () => {
    settleNoticeListeners.delete(listener)
  }
}

/** The newest request per machine; an older reply that lands later is dropped. */
const requests = new Map<string, number>()
/** The request whose `getProjects` is still out, per machine. */
const projectReads = new Map<string, number>()

/** The newest `getProjects` is still out, so its reply could put back a state a broadcast just changed. */
function newestReadOut(connectionId: string): boolean {
  const read = projectReads.get(connectionId)
  return read !== undefined && read === requests.get(connectionId)
}

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
        const text = settleBroadcastNotice(event)
        const undoable = getClient(connectionId)?.supportsCapability(CHAT_SETTLE_CAPABILITY) === true
        if (text !== null && event.settledAt !== null && undoable) {
          const undo: SettleUndo = {
            connectionId,
            id: event.conversationId,
            settledAt: event.settledAt,
            text,
            endedSnooze: event.endedSnooze,
          }
          for (const listener of settleNoticeListeners) listener(undo)
        }
        const patched = withSettled(get().sessions[connectionId] ?? [], event.conversationId, event.settledAt)
        if (patched) set((s) => ({ sessions: { ...s.sessions, [connectionId]: patched } }))
        // No row matched, or a read that is still out would put the old settledAt back.
        if (!patched || newestReadOut(connectionId)) void get().refresh(connectionId)
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

      applySnooze: (connectionId, event) => {
        const list = get().sessions[connectionId]
        const held = list?.some((session) => session.id === event.conversationId) === true
        const next = list && held ? withSnoozeEvent(list, event) : list
        if (next && next !== list) set((s) => ({ sessions: { ...s.sessions, [connectionId]: next } }))
        // Same rule as applySettled: an unknown id, or a read still out that would put the old snooze back.
        if (!held || newestReadOut(connectionId)) void get().refresh(connectionId)
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

function sessionOf(connectionId: string, id: string): RecentSession | undefined {
  return useRecentsStore.getState().sessions[connectionId]?.find((s) => s.id === id)
}

/** Snooze a chat from the sheet. Resolves to the line to show when it did not happen, or null. */
export async function snoozeChat(connectionId: string, id: string, choice: SnoozeChoice): Promise<string | null> {
  const client = getClient(connectionId)
  if (!client) return NOT_CONNECTED
  const now = Date.now()
  const asked = snoozeRequestFor(choice, now)
  if (!asked.ok) return snoozeRefusalText(asked.reason)
  try {
    const result = await client.snoozeConversation(id, asked.request)
    if (!result.ok) {
      log.info(`snooze refused for ${id}`, { reason: result.reason })
      return snoozeRefusalText(result.reason)
    }
    useRecentsStore.getState().applySnooze(connectionId, snoozedEvent(id, result, now))
    return null
  } catch (err) {
    log.warn(`could not snooze ${id}`, err)
    return 'Could not snooze. Try again'
  }
}

/**
 * Settle a Done or idle chat: the row leaves Recents at once and comes back
 * when the backend refuses. Resolves to the line to show when it did not happen, or null.
 */
export async function settleChat(connectionId: string, id: string, settledAt: number): Promise<string | null> {
  const client = getClient(connectionId)
  if (!client) return NOT_CONNECTED
  const before = sessionOf(connectionId, id)?.settledAt ?? null
  useRecentsStore.getState().applySettled(connectionId, { conversationId: id, settledAt })
  try {
    const result = await client.settleConversation(id)
    if (!result.ok) throw new Error('the chat has no stored row')
    return null
  } catch (err) {
    log.warn(`could not settle ${id}; the row comes back`, err)
    useRecentsStore.getState().applySettled(connectionId, { conversationId: id, settledAt: before })
    return 'Could not settle. Try again'
  }
}

/**
 * Undo a settle, as the desktop does: a settle that ended a snooze snoozes
 * again with its values and revision, a write that also unsettles; a refused
 * one (a PR-only snooze whose PR merged) only unsettles.
 */
export async function undoSettle(undo: SettleUndo): Promise<string | null> {
  const { connectionId, id } = undo
  const client = getClient(connectionId)
  if (!client) return NOT_CONNECTED
  useRecentsStore.getState().applySettled(connectionId, { conversationId: id, settledAt: null })
  const ended = undo.endedSnooze
  if (ended) {
    try {
      const now = Date.now()
      const result = await client.snoozeConversation(id, { until: ended.until, pr: ended.pr, expectRev: ended.rev })
      if (result.ok) {
        useRecentsStore.getState().applySnooze(connectionId, snoozedEvent(id, result, now))
        return null
      }
      log.info(`snooze not restored for ${id}`, { reason: result.reason })
    } catch (err) {
      log.warn(`snooze restore failed for ${id}`, err)
    }
  }
  try {
    const result = await client.unsettleConversation(id)
    if (!result.ok) throw new Error('the chat has no stored row')
    return null
  } catch (err) {
    log.warn(`unsettle failed for ${id}; the chat stays settled`, err)
    useRecentsStore.getState().applySettled(connectionId, { conversationId: id, settledAt: undo.settledAt })
    return 'Could not undo the settle. Try again'
  }
}

/** Wake now: end the snooze with no Woke marker. */
export async function wakeChat(connectionId: string, id: string): Promise<string | null> {
  const client = getClient(connectionId)
  if (!client) return NOT_CONNECTED
  try {
    const result = await client.unsnoozeConversation(id)
    if (!result.ok) return 'This chat is no longer snoozed'
    useRecentsStore
      .getState()
      .applySnooze(connectionId, wokenEvent(id, result.rev, sessionOf(connectionId, id)?.snoozeRev ?? 0))
    return null
  } catch (err) {
    log.warn(`could not wake ${id}`, err)
    return 'Could not wake the chat. Try again'
  }
}

/** Woke marks being cleared, by machine and chat: a second call while one runs does nothing. */
const clearingWoke = new Set<string>()

/**
 * The Thread screen of a woken chat opened: drop its Woke marker everywhere.
 * The phone keeps the mark until the backend clears it, so a failed request
 * leaves it to retry on the next call.
 */
export function markWokeSeen(connectionId: string, id: string): void {
  const session = sessionOf(connectionId, id)
  if (!session || !isWoke({ snoozedAt: session.snoozedAt ?? null, wokeAt: session.wokeAt ?? null })) return
  const client = getClient(connectionId)
  if (client?.supportsCapability(CHAT_SNOOZE_CAPABILITY) !== true) return
  const key = `${connectionId}:${id}`
  if (clearingWoke.has(key)) return
  clearingWoke.add(key)
  client
    .markWokeSeen(id)
    .then(
      () =>
        useRecentsStore.getState().applySnooze(connectionId, {
          conversationId: id,
          snoozedUntil: null,
          snoozedAt: null,
          snoozePr: null,
          snoozeRev: session.snoozeRev ?? 0,
          wokeAt: null,
          wokeReason: null,
        }),
      (err: unknown) => log.warn(`could not clear the Woke mark of ${id}`, err),
    )
    .finally(() => clearingWoke.delete(key))
}
