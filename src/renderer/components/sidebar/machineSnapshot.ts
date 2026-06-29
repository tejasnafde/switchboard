/**
 * Pure helpers for the offline cache: a relative "synced ago" label and access
 * to a snapshot's cached project list (read-only browse of an offline machine).
 */
import type { CachedProject, MachineSnapshot } from '@shared/machines'
import type { Project } from '@shared/types'

/** Trim a remote's live project list down to the cached shape we browse offline. */
export function projectsToSnapshot(projects: Project[], syncedAt: number): MachineSnapshot {
  return {
    syncedAt,
    projects: projects.map((p) => ({
      path: p.path,
      name: p.name,
      sessions: p.sessions.map((s) => ({ id: s.id, title: s.title })),
    })),
  }
}

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
