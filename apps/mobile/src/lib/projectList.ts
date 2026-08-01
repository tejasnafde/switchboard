/**
 * Pure helpers for the Projects screen. Separate from the screen so they can be
 * unit-tested without pulling React Native into the test environment.
 */
import type { Project } from '@shared/types'

/** A corrupt settings value must not throw; the screen falls back to scan order. */
export function parseOrder(json: string | null): string[] | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

/** Name or path, case-insensitive. Path matters: two checkouts differ only by directory. */
export function matchesQuery(p: Pick<Project, 'name' | 'path'>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle)
}
