import type { Project, SessionSummary, Workspace } from '@shared/types'

/**
 * Pure sidebar helpers. Kept out of Sidebar.tsx so they're trivially
 * testable without dragging in the renderer/dnd-kit/zustand deps.
 */

/**
 * Sort projects by a saved `projectOrder` (array of paths). Paths missing
 * from the order keep their relative position at the end. Used by the local
 * sidebar (settings key on the local DB) and by connected remote machines
 * (same key on the remote's own DB).
 */
export function applyProjectOrder<T extends { path: string }>(projects: T[], order: string[] | null): T[] {
  if (!order || order.length === 0) return projects
  const idx = new Map(order.map((p, i) => [p, i]))
  return [...projects].sort((a, b) => {
    const ai = idx.get(a.path) ?? -1
    const bi = idx.get(b.path) ?? -1
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

/** Compact "now / 5m / 3h / 2d / 4w / 3mo" stamp for sidebar thread rows. */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)
  // 28-30 days: already "4w" but not yet a full month - keep weeks, never "0mo".
  if (months < 1) return `${weeks}w`
  return `${months}mo`
}

export interface WorkspaceGroup {
  workspace: Workspace | null // null = the implicit "Ungrouped" pseudo-workspace
  projects: Project[]
}

/**
 * Partition projects into workspace groups. Workspaces are emitted in
 * `sortOrder` order, then "Ungrouped" last (only if it has any projects).
 * A project whose `workspaceId` doesn't match any known workspace is
 * treated as ungrouped - defensive against stale references after a
 * workspace was deleted between the renderer's last fetch and now.
 */
export function groupProjectsByWorkspace(
  projects: Project[],
  workspaces: Workspace[],
): WorkspaceGroup[] {
  const known = new Set(workspaces.map((w) => w.id))
  const byId = new Map<string, Project[]>()
  const ungrouped: Project[] = []
  for (const p of projects) {
    const wid = p.workspaceId
    if (wid && known.has(wid)) {
      const list = byId.get(wid) ?? []
      list.push(p)
      byId.set(wid, list)
    } else {
      ungrouped.push(p)
    }
  }
  const sorted = [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  const groups: WorkspaceGroup[] = sorted.map((w) => ({
    workspace: w,
    projects: byId.get(w.id) ?? [],
  }))
  if (ungrouped.length > 0) {
    groups.push({ workspace: null, projects: ungrouped })
  }
  return groups
}

/**
 * Stable color-token index for a workspace - picks one of `--workspace-color-1..6`
 * deterministically from the workspace id when no explicit color is set.
 * Used so a freshly-created workspace gets a sensible default tag without
 * forcing the user to pick a color.
 */
export function colorTokenForWorkspace(w: Workspace): string {
  if (w.color) return w.color // explicit hex/CSS-color value wins
  let h = 0
  for (let i = 0; i < w.id.length; i++) h = (h * 31 + w.id.charCodeAt(i)) | 0
  const idx = Math.abs(h) % 6 + 1
  return `var(--workspace-color-${idx})`
}

export interface FilteredTree {
  groups: WorkspaceGroup[]
  /** workspace ids that should auto-expand because they contain matches */
  expandWorkspaces: Set<string>
  /** project paths that should auto-expand because they contain matches */
  expandProjects: Set<string>
  /** total surviving sessions across all groups (for "no matches" UI) */
  matchCount: number
}

/**
 * Apply a fuzzy substring filter to the grouped tree. Returns a new tree
 * with non-matching sessions/projects/workspaces stripped, plus the set
 * of ancestors that should be force-expanded so the matches are visible.
 *
 * Empty / whitespace-only query returns the original tree unchanged with
 * empty expand sets - caller should restore previous collapse state.
 */
export function applySidebarFilter(query: string, groups: WorkspaceGroup[]): FilteredTree {
  const q = query.trim().toLowerCase()
  if (!q) {
    return { groups, expandWorkspaces: new Set(), expandProjects: new Set(), matchCount: -1 }
  }
  const expandWs = new Set<string>()
  const expandProj = new Set<string>()
  let matchCount = 0
  const filteredGroups: WorkspaceGroup[] = []
  for (const g of groups) {
    const filteredProjects: Project[] = []
    for (const p of g.projects) {
      const sessions = p.sessions.filter((s: SessionSummary) =>
        (s.title || '').toLowerCase().includes(q)
      )
      if (sessions.length > 0) {
        matchCount += sessions.length
        expandProj.add(p.path)
        if (g.workspace) expandWs.add(g.workspace.id)
        else expandWs.add('__ungrouped__')
        filteredProjects.push({ ...p, sessions })
      }
    }
    if (filteredProjects.length > 0) {
      filteredGroups.push({ workspace: g.workspace, projects: filteredProjects })
    }
  }
  return { groups: filteredGroups, expandWorkspaces: expandWs, expandProjects: expandProj, matchCount }
}
