export const RECENT_SESSION_LIMITS = [4, 6, 8, 12] as const
export type RecentSessionLimit = typeof RECENT_SESSION_LIMITS[number]
export const DEFAULT_RECENT_SESSION_LIMIT: RecentSessionLimit = 4
export const RECENT_SESSION_PAGE_SIZE = 5
export const RECENT_SESSION_LIMIT_SETTING = 'sidebar.recentSessionLimit'
export const RECENT_SESSION_LIMIT_CHANGED = 'sb-recent-session-limit-changed'

export function parseRecentSessionLimit(value: string | null): RecentSessionLimit {
  const parsed = Number(value)
  return RECENT_SESSION_LIMITS.find((limit) => limit === parsed) ?? DEFAULT_RECENT_SESSION_LIMIT
}

export function resolveLoadedRecentSessionLimit(
  value: string | null,
  selectedSinceLoadStarted: boolean,
): RecentSessionLimit | null {
  return selectedSinceLoadStarted ? null : parseRecentSessionLimit(value)
}

export function visibleRecentSessions<T>(items: T[], limit: RecentSessionLimit, revealedCount: number): T[] {
  return items.slice(0, limit + revealedCount)
}

export function nextRecentSessionRevealCount(
  total: number,
  limit: RecentSessionLimit,
  revealedCount: number,
): number {
  return Math.min(Math.max(0, total - limit), revealedCount + RECENT_SESSION_PAGE_SIZE)
}
