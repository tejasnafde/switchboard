export const RECENT_SESSION_LIMITS = [4, 6, 8, 12] as const
export type RecentSessionLimit = typeof RECENT_SESSION_LIMITS[number]
export const DEFAULT_RECENT_SESSION_LIMIT: RecentSessionLimit = 4
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

export function visibleRecentSessions<T>(items: T[], limit: RecentSessionLimit, expanded: boolean): T[] {
  return expanded ? items : items.slice(0, limit)
}
