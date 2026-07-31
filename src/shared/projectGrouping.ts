/**
 * Workspace grouping and project ordering.
 *
 * Lives in shared/ because the desktop sidebar and the mobile Projects screen
 * must group projects identically - the phone is supposed to show the same
 * workspaces in the same order as the Mac. Two copies of this would drift.
 *
 * Pure, no electron/react imports, per the shared/ contract.
 */
import type { Project, Workspace } from './types'

/**
 * Sort projects by a saved `projectOrder` (array of paths). Paths missing from
 * the order keep their relative position at the end. Used by the local sidebar
 * (settings key on the local DB) and by connected remote machines (same key on
 * the remote's own DB).
 */
export function applyProjectOrder<T extends { path: string }>(projects: T[], order: string[] | null): T[] {
  // `order` comes from a persisted setting - a corrupt row can hold valid JSON
  // that isn't an array. Guard here so every caller falls back to scan order
  // instead of throwing outside its parse try/catch.
  if (!Array.isArray(order) || order.length === 0) return projects
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

