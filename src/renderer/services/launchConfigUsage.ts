/**
 * Local recently-used tracker for launch configs.
 *
 * Drives the picker dropdown's sort order: most-recently-applied
 * launch configs float to the top per project. Backed by `localStorage`
 * because (a) it's a UI-affordance preference, (b) it's per-laptop,
 * not per-account, and (c) it doesn't warrant a SQLite migration for
 * what's effectively a sort key.
 *
 * Schema:
 *   key: `sb-launch-config-usage`
 *   value: { [projectPath]: { [launchConfigName]: lastUsedMs } }
 *
 * `default` is special-cased: it sorts first when no other launch config
 * has been used in the project, so a fresh project still gets a
 * sensible top-of-list pick.
 */
const STORAGE_KEY = 'sb-launch-config-usage'

type UsageMap = Record<string, Record<string, number>>

function read(): UsageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(map: UsageMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* localStorage full / unavailable - silently no-op; sort just falls back to alphabetical */
  }
}

export function recordLaunchConfigUsage(projectPath: string, launchConfigName: string): void {
  const map = read()
  if (!map[projectPath]) map[projectPath] = {}
  map[projectPath][launchConfigName] = Date.now()
  write(map)
}

export function getLaunchConfigUsage(projectPath: string): Record<string, number> {
  return read()[projectPath] ?? {}
}

/**
 * Sort launch configs by recency desc, then alphabetical for launch configs
 * with no recorded use. `default` is pinned to the top of the
 * "no recorded use" bucket so first-time users see it first.
 */
export function sortLaunchConfigsByRecency(
  names: string[],
  projectPath: string,
): string[] {
  const usage = getLaunchConfigUsage(projectPath)
  return [...names].sort((a, b) => {
    const ua = usage[a] ?? 0
    const ub = usage[b] ?? 0
    if (ua !== ub) return ub - ua
    if (a === 'default') return -1
    if (b === 'default') return 1
    return a.localeCompare(b)
  })
}
