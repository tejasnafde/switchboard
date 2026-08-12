import type { Project, SessionSummary, Workspace } from '@shared/types'

/**
 * Pure sidebar helpers. Kept out of Sidebar.tsx so they're trivially
 * testable without dragging in the renderer/dnd-kit/zustand deps.
 */

// Grouping and ordering moved to shared/ so the mobile Projects screen groups
// projects the same way. Re-exported here to keep existing import sites valid.
import type { WorkspaceGroup } from '@shared/projectGrouping'

export {
  groupProjectsByWorkspace,
  colorTokenForWorkspace,
  type WorkspaceGroup,
} from '@shared/projectGrouping'

/** Compact "now / 5m / 3h / 2d / 4w / 3mo" stamp for sidebar thread rows. */
export { formatRelativeTime } from '@shared/format'

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
