/**
 * Pure rules behind the grouped Recents list and the folded machine rows:
 * which group and dot colour a chat gets, how many rows "Show N more" keeps
 * back, and the count labels. The components only render what these return.
 */
import type { RecentSessionStatus } from './recent-sessions'
import { RECENT_SESSION_PAGE_SIZE } from './recent-session-limit'

export type RecentDot = 'needs-you' | 'working' | 'finished' | 'idle'
export type RecentGroupKey = 'needs-you' | 'working' | 'done'

export const RECENT_GROUP_LABELS: Record<RecentGroupKey, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  done: 'Done recently',
}

export const RECENT_DOT_LABELS: Record<RecentDot, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  finished: 'Just finished',
  idle: 'Idle',
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

/**
 * Split an already sorted Recents list into its groups. "Needs you" and
 * "Working" always show in full, whatever the limit: a chat waiting on the
 * user must never sit behind "Show more". "Done recently" fills the rest of
 * the configured limit, plus whatever "Show more" has revealed.
 */
export function groupRecentSessions<T extends { status?: RecentSessionStatus }>(
  items: readonly T[],
  limit: number,
  revealedCount: number,
): { groups: RecentGroup<T>[]; hiddenCount: number; nextRevealCount: number } {
  const byKey: Record<RecentGroupKey, T[]> = { 'needs-you': [], working: [], done: [] }
  for (const item of items) byKey[recentGroupKey(item.status)].push(item)
  const urgent = byKey['needs-you'].length + byKey.working.length
  const doneShown = Math.min(byKey.done.length, Math.max(0, limit - urgent) + revealedCount)
  const hiddenCount = byKey.done.length - doneShown
  const groups = (['needs-you', 'working', 'done'] as const)
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
