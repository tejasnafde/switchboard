/**
 * Pure rules behind the grouped Recents list and the folded machine rows:
 * which group and dot colour a chat gets, how many rows "Show N more" keeps
 * back, and the count labels. The components only render what these return.
 */
import type { RecentSessionStatus } from './recent-sessions'
import { RECENT_SESSION_PAGE_SIZE } from './recent-session-limit'
import { isSettled } from '@shared/chat-settle'
import { isSnoozed, isWoke } from '@shared/chat-snooze'

export type RecentDot = 'needs-you' | 'working' | 'finished' | 'idle' | 'snoozed'
export type RecentGroupKey = 'needs-you' | 'working' | 'done' | 'snoozed'

export const RECENT_GROUP_LABELS: Record<RecentGroupKey, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  done: 'Done recently',
  snoozed: 'Snoozed',
}

export const RECENT_DOT_LABELS: Record<RecentDot, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  finished: 'Just finished',
  idle: 'Idle',
  snoozed: 'Snoozed',
}

export function recentDot(status: RecentSessionStatus | undefined): RecentDot {
  switch (status) {
    case 'approval':
    case 'input':
    case 'plan':
    case 'failed':
      return 'needs-you'
    case 'working':
      return 'working'
    case 'done':
      return 'finished'
    default:
      return 'idle'
  }
}

export function recentGroupKey(status: RecentSessionStatus | undefined): RecentGroupKey {
  const dot = recentDot(status)
  return dot === 'needs-you' || dot === 'working' ? dot : 'done'
}

export interface RecentGroup<T> {
  key: RecentGroupKey
  label: string
  items: T[]
}

type GroupableSession = {
  settledAt?: number | null
  snoozedAt?: number | null
  snoozedUntil?: number | null
  wokeAt?: number | null
}

/** A snoozed chat sits in Snoozed whatever its live status, until it wakes. */
export function recentItemGroupKey(item: { status?: RecentSessionStatus; session?: GroupableSession }): RecentGroupKey {
  if (item.session && isSnoozed({ snoozedAt: item.session.snoozedAt ?? null })) return 'snoozed'
  return recentGroupKey(item.status)
}

export function isWokeItem(item: { session?: GroupableSession }): boolean {
  return !!item.session && isWoke({ snoozedAt: item.session.snoozedAt ?? null, wokeAt: item.session.wokeAt ?? null })
}

/**
 * Split an already sorted Recents list into its groups. "Needs you" and
 * "Working" always show in full, whatever the limit: a chat waiting on the
 * user must never sit behind "Show more". "Done recently" fills the rest of
 * the configured limit, plus whatever "Show more" has revealed, and leaves
 * out a settled chat (it stays in its workspace tree). A woken Done row sorts
 * first and is never held back. "Snoozed" comes last, soonest wake first and
 * PR-only snoozes after, and does not count toward the limit.
 */
export function groupRecentSessions<T extends { status?: RecentSessionStatus; session?: GroupableSession }>(
  items: readonly T[],
  limit: number,
  revealedCount: number,
): { groups: RecentGroup<T>[]; hiddenCount: number; nextRevealCount: number } {
  const byKey: Record<RecentGroupKey, T[]> = { 'needs-you': [], working: [], done: [], snoozed: [] }
  for (const item of items) {
    const key = recentItemGroupKey(item)
    if (key === 'done' && item.session && isSettled(item.session.settledAt)) continue
    byKey[key].push(item)
  }
  const woke = byKey.done.filter(isWokeItem)
  if (woke.length > 0) byKey.done = [...woke, ...byKey.done.filter((item) => !isWokeItem(item))]
  byKey.snoozed.sort((a, b) => (a.session?.snoozedUntil ?? Infinity) - (b.session?.snoozedUntil ?? Infinity))
  const urgent = byKey['needs-you'].length + byKey.working.length
  const doneShown = Math.max(woke.length, Math.min(byKey.done.length, Math.max(0, limit - urgent) + revealedCount))
  const hiddenCount = byKey.done.length - doneShown
  const groups = (['needs-you', 'working', 'done', 'snoozed'] as const)
    .map((key) => ({
      key,
      label: RECENT_GROUP_LABELS[key],
      items: key === 'done' ? byKey.done.slice(0, doneShown) : byKey[key],
    }))
    .filter((group) => group.items.length > 0)
  return {
    groups,
    hiddenCount,
    nextRevealCount: revealedCount + Math.min(hiddenCount, RECENT_SESSION_PAGE_SIZE),
  }
}

export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** "This Mac" row summary, e.g. "7 workspaces, 69 projects". */
export function localMachineSummary(workspaceCount: number, projectCount: number): string {
  const projects = countLabel(projectCount, 'project')
  return workspaceCount > 0 ? `${countLabel(workspaceCount, 'workspace')}, ${projects}` : projects
}
