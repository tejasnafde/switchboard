/**
 * Pure helpers for the Projects screen. Separate from the screen so they can be
 * unit-tested without pulling React Native into the test environment.
 */
import type { Project } from '@shared/types'

/** Name or path, case-insensitive. Path matters: two checkouts differ only by directory. */
export function matchesQuery(p: Pick<Project, 'name' | 'path'>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle)
}

export interface SavedProjectsStatus {
  label: string
  detail?: string
  loading: boolean
  canRetry: boolean
}

/**
 * The note over a project list that did not come from the machine just now
 * (Android's `BrowseProjectionPolicy.status`). Null while the list is live.
 */
export function savedProjectsStatus(live: boolean, error: string | null): SavedProjectsStatus | null {
  if (error !== null) return { label: 'Showing saved projects', detail: error, loading: false, canRetry: true }
  if (live) return null
  return { label: 'Showing saved projects', loading: true, canRetry: false }
}
