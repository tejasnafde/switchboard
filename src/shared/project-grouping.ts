/**
 * Workspace grouping and project ordering. In shared/ because the desktop
 * sidebar and the mobile Projects screen must group identically; two copies
 * would drift. Pure, per the shared/ contract.
 */
import type { Project, Workspace } from './types'

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
