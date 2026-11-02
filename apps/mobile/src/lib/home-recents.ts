/**
 * Home > Recents: the newest chats across every paired machine, with what each
 * one needs. The same rules as native Android's `HomePresenter`
 * (ui/home/HomePresentation.kt): attention outranks Working, which outranks
 * Failed, then Done (unread), then the rest, each newest first.
 *
 * A chat's status comes only from this run: live events, plus the backend's
 * `provider:list-sessions` reply, and only while its machine is connected. A
 * status restored from disk is never shown, so a turn that ended while the app
 * was closed cannot read Working. The cached feed names an open approval or
 * question only for a chat whose status is live this run; a plan is never
 * read from it.
 *
 * Snooze (`@shared/chat-snooze`, only from a backend with `chat_snooze_v1`): a
 * snoozed chat leaves Recents for the Snoozed shelf whatever its live status,
 * until it wakes; a woken chat sorts first in its status and shows Woke until
 * its Thread screen opens.
 */
import type { Project } from '@shared/types'
import { formatRelativeTime } from '@shared/format'
import { withoutDemo } from '@shared/phone-demo/phone-demo'
import { isSettled } from '@shared/chat-settle'
import {
  compareSnoozeWake,
  isSnoozed,
  isWoke,
  type ConversationSnoozedEvent,
  type WakeReason,
} from '@shared/chat-snooze'
import type { FeedItem, ThreadState } from '../stores/chat'

export const HOME_RECENT_PAGE_SIZE = 5

export type HomeRecentStatus = 'Approval' | 'Input' | 'Working' | 'Failed' | 'Done'

/** One chat from a machine's project list, kept for Home. */
export interface RecentSession {
  id: string
  title: string
  startedAt: number
  projectPath: string
  projectName: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  /** Settled on a desktop: Home leaves the chat out while it is Done or idle. */
  settledAt?: number | null
  /** Snooze and the Woke marker; absent from an older backend. */
  snoozedUntil?: number | null
  snoozedAt?: number | null
  snoozePr?: string | null
  snoozeRev?: number
  wokeAt?: number | null
  wokeReason?: WakeReason | null
  wokePrSummary?: string | null
}

/** A `provider:list-sessions` reply, with the `statusMark()` taken before asking. */
export interface LiveStatuses {
  mark: number
  statuses: Record<string, string>
}

export interface HomeMachine {
  connectionId: string
  label: string
  connected: boolean
  sessions: RecentSession[]
  live?: LiveStatuses
  /** The backend has `chat_snooze_v1`; without it every snooze field is ignored. */
  snooze?: boolean
}

export interface HomeRecentRow extends RecentSession {
  connectionId: string
  connectionLabel: string
  status: HomeRecentStatus | null
  unread: number
  /** Its machine can snooze it. */
  snoozable: boolean
  /** Woke from a snooze and not opened since. */
  woke: boolean
}

export interface HomeRecentsPage {
  items: HomeRecentRow[]
  total: number
  /** The Snoozed shelf: the soonest wake first, PR-only last. */
  snoozed: HomeRecentRow[]
}

type ThreadActivity = Pick<ThreadState, 'items' | 'status' | 'statusAt' | 'unread'>

/** Every chat of a project list, once each, in project order. */
export function sessionsFromProjects(projects: Project[]): RecentSession[] {
  const seen = new Set<string>()
  const out: RecentSession[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      out.push({
        id: session.id,
        title: session.title,
        startedAt: session.startedAt,
        projectPath: project.path,
        projectName: project.name,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
        settledAt: session.settledAt,
        snoozedUntil: session.snoozedUntil,
        snoozedAt: session.snoozedAt,
        snoozePr: session.snoozePr,
        snoozeRev: session.snoozeRev,
        wokeAt: session.wokeAt,
        wokeReason: session.wokeReason,
        wokePrSummary: session.wokePrSummary,
      })
    }
  }
  return out
}

/** The `max` most recently started chats. */
export function newestSessions(sessions: RecentSession[], max: number): RecentSession[] {
  return [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, max)
}

/** The status this run knows for a chat, or null. */
export function liveStatus(
  threadId: string,
  thread: ThreadActivity | undefined,
  live: LiveStatuses | undefined,
): string | null {
  const at = thread?.statusAt
  // A status a live event set after the reply was asked for beats the reply.
  if (live && !(at !== undefined && at > live.mark)) return live.statuses[threadId] ?? null
  return thread && at !== undefined ? thread.status : null
}

function attention(items: FeedItem[]): HomeRecentStatus | null {
  if (items.some((i) => i.kind === 'approval' && i.state === 'pending' && !i.closed)) return 'Approval'
  if (items.some((i) => i.kind === 'question' && i.answers === undefined)) return 'Input'
  return null
}

export function recentStatus(
  threadId: string,
  thread: ThreadActivity | undefined,
  machine: Pick<HomeMachine, 'connected' | 'live'>,
): HomeRecentStatus | null {
  const status = machine.connected ? liveStatus(threadId, thread, machine.live)?.toLowerCase() : undefined
  // A provider that errored or stopped leaves nothing open.
  const needs =
    machine.connected && thread?.statusAt !== undefined && status !== 'error' && status !== 'stopped'
      ? attention(thread.items)
      : null
  if (needs) return needs
  switch (status) {
    case 'running':
    case 'thinking':
    case 'streaming':
    case 'working':
      return 'Working'
    case 'error':
    case 'failed':
      return 'Failed'
    default:
      return (thread?.unread ?? 0) > 0 ? 'Done' : null
  }
}

const PRIORITY: Record<HomeRecentStatus, number> = { Approval: 5, Input: 4, Working: 3, Failed: 2, Done: 1 }

export function homeRecents(
  machines: HomeMachine[],
  threads: Record<string, ThreadActivity>,
  limit = HOME_RECENT_PAGE_SIZE,
): HomeRecentsPage {
  const all: HomeRecentRow[] = machines.flatMap((machine) =>
    machine.sessions.map((session) => {
      const thread = threads[`${machine.connectionId}:${session.id}`]
      const snoozable = machine.snooze === true
      return {
        ...session,
        title: session.title.trim() === '' ? 'Untitled chat' : session.title,
        connectionId: machine.connectionId,
        connectionLabel: machine.label,
        status: recentStatus(session.id, thread, machine),
        unread: thread?.unread ?? 0,
        snoozable,
        woke: snoozable && isWoke({ snoozedAt: session.snoozedAt ?? null, wokeAt: session.wokeAt ?? null }),
      }
    }),
  )
  const snoozed = all
    .filter(isShelved)
    .sort((a, b) =>
      compareSnoozeWake({ snoozedUntil: a.snoozedUntil ?? null }, { snoozedUntil: b.snoozedUntil ?? null }),
    )
  const rows = all
    .filter((row) => !isShelved(row))
    // A settled chat leaves the desktop's "Done recently" only, so it still shows while it works or waits.
    .filter((row) => !((row.status === null || row.status === 'Done') && isSettled(row.settledAt)))
  rows.sort(
    (a, b) =>
      (b.status ? PRIORITY[b.status] : 0) - (a.status ? PRIORITY[a.status] : 0) ||
      Number(b.woke) - Number(a.woke) ||
      b.startedAt - a.startedAt,
  )
  return { items: rows.slice(0, Math.max(0, limit)), total: rows.length, snoozed }
}

function isShelved(row: HomeRecentRow): boolean {
  return row.snoozable && isSnoozed({ snoozedAt: row.snoozedAt ?? null })
}

/** A chat that needs the user cannot be snoozed: the open card or the error would wake it at once. */
export function canSnooze(row: HomeRecentRow): boolean {
  return row.snoozable && row.status !== 'Approval' && row.status !== 'Input' && row.status !== 'Failed'
}

/** A machine's chat list after a snooze broadcast; the same list when it names none of them. */
export function withSnoozeEvent(sessions: RecentSession[], event: ConversationSnoozedEvent): RecentSession[] {
  const { conversationId, title: _title, prSummary, ...state } = event
  if (!sessions.some((s) => s.id === conversationId)) return sessions
  return sessions.map((s) => (s.id === conversationId ? { ...s, ...state, wokePrSummary: prSummary ?? null } : s))
}

const WEEK_MS = 7 * 24 * 3_600_000

/** A row's time when it has no status: relative for a week, then a short date. Seconds or milliseconds, like Android. */
export function homeRelativeTime(startedAt: number, now = Date.now()): string {
  if (startedAt <= 0) return ''
  const at = startedAt < 10_000_000_000 ? startedAt * 1000 : startedAt
  return now - at < WEEK_MS
    ? formatRelativeTime(at)
    : new Date(at).toLocaleDateString(undefined, { dateStyle: 'short' })
}

/** What `stores/recents.ts` writes to disk: each machine's newest chats, never the demo's. */
export function persistedRecents(
  sessions: Record<string, RecentSession[]>,
  max: number,
): Record<string, RecentSession[]> {
  return Object.fromEntries(Object.entries(withoutDemo(sessions)).map(([id, list]) => [id, newestSessions(list, max)]))
}
