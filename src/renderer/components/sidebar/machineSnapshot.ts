/**
 * Pure helpers for the offline cache: a relative "synced ago" label and access
 * to a snapshot's cached project list (read-only browse of an offline machine).
 */
import type { CachedProject, MachineSnapshot } from '@shared/machines'

export function syncedAgoLabel(syncedAt: number | undefined, now: number): string {
  if (!syncedAt) return ''
  const s = Math.floor((now - syncedAt) / 1000)
  if (s < 60) return 'synced just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `synced ${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `synced ${h}h ago`
  return `synced ${Math.floor(h / 24)}d ago`
}

export function cachedProjects(snapshot: MachineSnapshot | undefined): CachedProject[] {
  return snapshot?.projects ?? []
}
