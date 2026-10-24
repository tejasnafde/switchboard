/**
 * Home > Recents: the newest chats across every paired machine, with what each
 * one needs. The same rules as native Android's `HomePresenter`
 * (ui/home/HomePresentation.kt): attention outranks Working, which outranks
 * Failed, then Done (unread), then the rest, each newest first.
 *
 * A chat's status comes only from this run: live events, plus the backend's
 * `provider:list-sessions` reply. A status restored from disk is never shown,
 * so a turn that ended while the app was closed cannot read Working.
 */
import type { Project } from '@shared/types'
import { formatRelativeTime } from '@shared/format'
import type { FeedItem, ThreadState } from '../stores/chat'

export const HOME_RECENT_PAGE_SIZE = 5

export type HomeRecentStatus = 'Approval' | 'Input' | 'Plan' | 'Working' | 'Failed' | 'Done'

/** One chat from a machine's project list, kept for Home. */
export interface RecentSession {
  id: string
  title: string
  startedAt: number
  projectPath: string
  projectName: string
  worktreePath?: string | null
  worktreeBranch?: string | null
}

/** A `provider:list-sessions` reply, with the `statusMark()` taken before asking. */
export interface LiveStatuses {
  mark: number
  statuses: Record<string, string>
}

export interface HomeMachine {
  connectionId: string
  label: string
  sessions: RecentSession[]
  live?: LiveStatuses
}

export interface HomeRecentRow extends RecentSession {
  connectionId: string
  connectionLabel: string
  status: HomeRecentStatus | null
  unread: number
}

export interface HomeRecentsPage {
  items: HomeRecentRow[]
  total: number
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
  // A proposed plan waits until the next user message answers it.
  const lastPlan = items.findLastIndex((i) => i.kind === 'plan')
  if (lastPlan >= 0 && lastPlan > items.findLastIndex((i) => i.kind === 'user')) return 'Plan'
  return null
}

export function recentStatus(
  threadId: string,
  thread: ThreadActivity | undefined,
  live: LiveStatuses | undefined,
): HomeRecentStatus | null {
  const needs = attention(thread?.items ?? [])
  if (needs) return needs
  switch (liveStatus(threadId, thread, live)?.toLowerCase()) {
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

const PRIORITY: Record<HomeRecentStatus, number> = { Approval: 5, Input: 4, Plan: 4, Working: 3, Failed: 2, Done: 1 }

export function homeRecents(
  machines: HomeMachine[],
  threads: Record<string, ThreadActivity>,
  limit = HOME_RECENT_PAGE_SIZE,
): HomeRecentsPage {
  const rows: HomeRecentRow[] = machines.flatMap((machine) =>
    machine.sessions.map((session) => {
      const thread = threads[`${machine.connectionId}:${session.id}`]
      return {
        ...session,
        title: session.title.trim() === '' ? 'Untitled chat' : session.title,
        connectionId: machine.connectionId,
        connectionLabel: machine.label,
        status: recentStatus(session.id, thread, machine.live),
        unread: thread?.unread ?? 0,
      }
    }),
  )
  rows.sort(
    (a, b) => (b.status ? PRIORITY[b.status] : 0) - (a.status ? PRIORITY[a.status] : 0) || b.startedAt - a.startedAt,
  )
  return { items: rows.slice(0, Math.max(0, limit)), total: rows.length }
}

/** A row's time when it has no status. Seconds or milliseconds, like Android; nothing for no time. */
export function homeRelativeTime(startedAt: number): string {
  if (startedAt <= 0) return ''
  return formatRelativeTime(startedAt < 10_000_000_000 ? startedAt * 1000 : startedAt)
}
