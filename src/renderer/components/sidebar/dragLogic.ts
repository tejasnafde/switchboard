/**
 * Pure dispatcher for sidebar drag-end events. Splits the two cases that
 * used to live tangled inside `handleDragEnd`:
 *
 *   • Same-workspace drop  → reorder within the flat project list.
 *   • Cross-workspace drop → reassign workspaceId; reorder is skipped.
 *
 * Returning a discriminated outcome keeps the React handler thin (it just
 * fires the side effect named here) and makes the logic testable without
 * dnd-kit or a DOM.
 */
import type { Project } from '@shared/types'

export type DragOutcome =
  | { type: 'noop' }
  | { type: 'reassign'; projectPath: string; targetWorkspaceId: string | null }
  | { type: 'reorder'; oldIndex: number; newIndex: number }

export function decideDragOutcome(
  projects: Project[],
  activeId: string,
  overId: string,
): DragOutcome {
  if (activeId === overId) return { type: 'noop' }

  const active = projects.find((p) => p.path === activeId)
  const over = projects.find((p) => p.path === overId)
  if (!active || !over) return { type: 'noop' }

  const activeWs = active.workspaceId ?? null
  const overWs = over.workspaceId ?? null
  if (activeWs !== overWs) {
    return { type: 'reassign', projectPath: active.path, targetWorkspaceId: overWs }
  }

  const oldIndex = projects.findIndex((p) => p.path === activeId)
  const newIndex = projects.findIndex((p) => p.path === overId)
  if (oldIndex === -1 || newIndex === -1) return { type: 'noop' }
  return { type: 'reorder', oldIndex, newIndex }
}
