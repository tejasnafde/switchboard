/**
 * The worktree manager's list rules that are not the backend's business:
 * which rows show under a tab, which can be ticked for a batch, and what the
 * footer says about the selection and the hidden protected rows.
 */
import {
  baseName,
  classifyWorktree,
  formatBytes,
  matchesFilter,
  type WorktreeFilter,
  type WorktreeRow,
} from '@shared/worktree-manager'

/** Only rows that lose nothing can join a batch; everything else is removed one at a time, or not at all. */
export function canBatchRemove(row: WorktreeRow): boolean {
  return classifyWorktree(row) === 'safe'
}

export function visibleRows(rows: readonly WorktreeRow[], filter: WorktreeFilter, showProtected: boolean): WorktreeRow[] {
  return rows.filter((row) => matchesFilter(row, filter) || (showProtected && classifyWorktree(row) === 'protected'))
}

/** Drops ticked paths that are gone or no longer safe after a reload. */
export function pruneSelection(selected: ReadonlySet<string>, rows: readonly WorktreeRow[]): Set<string> {
  const safe = new Set(rows.filter(canBatchRemove).map((row) => row.path))
  return new Set([...selected].filter((path) => safe.has(path)))
}

/** "Remove 2.9 GB" once every selected size is known, else "Remove 2". */
export function removeButtonLabel(selected: ReadonlySet<string>, sizes: ReadonlyMap<string, number | null>): string {
  let total = 0
  for (const path of selected) {
    const bytes = sizes.get(path)
    if (bytes === undefined || bytes === null) return `Remove ${selected.size}`
    total += bytes
  }
  return `Remove ${formatBytes(total)}`
}

/** The footer's note about what protection hides, or null when nothing is hidden. */
export function protectedNote(rows: readonly WorktreeRow[]): string | null {
  const hidden = rows.filter((row) => classifyWorktree(row) === 'protected')
  if (hidden.length === 0) return null
  const projects = [...new Set(hidden.filter((r) => r.protectedBy === 'project').map((r) => r.projectName || baseName(r.projectPath)))]
  const count = `${hidden.length} worktree${hidden.length === 1 ? '' : 's'}`
  if (projects.length === 1 && hidden.every((r) => r.protectedBy === 'project')) {
    return `${projects[0]} is protected and hidden (${count}).`
  }
  return `${count} protected and hidden.`
}

/** The Archive & data summary line. */
export function inventorySummary(rows: readonly WorktreeRow[]): string {
  if (rows.length === 0) return 'No worktrees.'
  const safe = rows.filter(canBatchRemove).length
  return `${rows.length} worktree${rows.length === 1 ? '' : 's'} · ${safe} safe to remove`
}
