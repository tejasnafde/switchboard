/**
 * Local recently-used tracker for workspace templates.
 *
 * Drives the picker dropdown's sort order: most-recently-applied
 * templates float to the top per project. Backed by `localStorage`
 * because (a) it's a UI-affordance preference, (b) it's per-laptop,
 * not per-account, and (c) it doesn't warrant a SQLite migration for
 * what's effectively a sort key.
 *
 * Schema:
 *   key: `sb-template-usage`
 *   value: { [projectPath]: { [templateName]: lastUsedMs } }
 *
 * `default` is special-cased: it sorts first when no other template
 * has been used in the project, so a fresh project still gets a
 * sensible top-of-list pick.
 */
const STORAGE_KEY = 'sb-template-usage'

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
    /* localStorage full / unavailable — silently no-op; sort just falls back to alphabetical */
  }
}

export function recordTemplateUsage(projectPath: string, templateName: string): void {
  const map = read()
  if (!map[projectPath]) map[projectPath] = {}
  map[projectPath][templateName] = Date.now()
  write(map)
}

export function getTemplateUsage(projectPath: string): Record<string, number> {
  return read()[projectPath] ?? {}
}

/**
 * Sort templates by recency desc, then alphabetical for templates
 * with no recorded use. `default` is pinned to the top of the
 * "no recorded use" bucket so first-time users see it first.
 */
export function sortTemplatesByRecency(
  names: string[],
  projectPath: string,
): string[] {
  const usage = getTemplateUsage(projectPath)
  return [...names].sort((a, b) => {
    const ua = usage[a] ?? 0
    const ub = usage[b] ?? 0
    if (ua !== ub) return ub - ua
    if (a === 'default') return -1
    if (b === 'default') return 1
    return a.localeCompare(b)
  })
}
