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
