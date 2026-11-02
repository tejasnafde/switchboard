/**
 * Each listed chat's snooze and Woke marker, for the views that do not hold
 * the session lists (the composer line, the palette, a row's menu). The
 * sidebar seeds it from its lists; `services/chat-inbox.ts` patches it with
 * the same change it gives the lists.
 */
import { create } from 'zustand'
import type { SessionSummary } from '@shared/types'

export type ChatSnoozeField =
  | 'snoozedUntil'
  | 'snoozedAt'
  | 'snoozePr'
  | 'snoozeRev'
  | 'wokeAt'
  | 'wokeReason'
  | 'wokePrSummary'
export type ChatSnooze = Partial<Pick<SessionSummary, ChatSnoozeField>>

/** Pick the snooze fields of a session. */
export function snoozeOf(session: ChatSnooze): Required<ChatSnooze> {
  return {
    snoozedUntil: session.snoozedUntil ?? null,
    snoozedAt: session.snoozedAt ?? null,
    snoozePr: session.snoozePr ?? null,
    snoozeRev: session.snoozeRev ?? 0,
    wokeAt: session.wokeAt ?? null,
    wokeReason: session.wokeReason ?? null,
    wokePrSummary: session.wokePrSummary ?? null,
  }
}

interface SnoozeStore {
  byId: Record<string, ChatSnooze>
  patch: (id: string, fields: ChatSnooze) => void
  /** Take every listed session's fields; a chat not listed keeps what it had. */
  seed: (sessions: Iterable<SessionSummary>) => void
}

function same(a: ChatSnooze | undefined, b: ChatSnooze): boolean {
  if (!a) return false
  return (Object.keys(b) as ChatSnoozeField[]).every((key) => a[key] === b[key])
}

export const useSnoozeStore = create<SnoozeStore>((set, get) => ({
  byId: {},
  patch: (id, fields) => {
    const prev = get().byId[id]
    const next = { ...prev, ...fields }
    if (same(prev, next)) return
    set({ byId: { ...get().byId, [id]: next } })
  },
  seed: (sessions) => {
    const byId = get().byId
    let changed: Record<string, ChatSnooze> | null = null
    for (const session of sessions) {
      const fields = snoozeOf(session)
      if (same(byId[session.id], fields)) continue
      changed ??= { ...byId }
      changed[session.id] = fields
    }
    if (changed) set({ byId: changed })
  },
}))
