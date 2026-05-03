/**
 * Pure dispatcher for sidebar drag-end events. Splits the two cases that
 * used to live tangled inside `handleDragEnd`:
 *
 *   • Same-workspace drop  → reorder within the rendered project list.
 *   • Cross-workspace drop → reassign the dragged project's workspaceId
 *     AND reorder, so the dropped item lands at its visual drop slot
 *     (rather than wherever it happened to sit in the raw array).
 *
 * Both outcomes carry `oldIndex`/`newIndex` in the *rendered* flat order
 * (the same array passed to `SortableContext.items`) — NOT the raw
 * `projects` array order. The caller persists by applying `arrayMove`
 * to the rendered order and rebuilding `projects` from that, which keeps
 * raw and rendered axes in lockstep.
 *
 * Why rendered order matters: `groupProjectsByWorkspace` emits buckets
 * by `workspace.sortOrder`, so the rendered flat order can differ from
 * `projects` array order whenever the saved `projectOrder` interleaves
 * workspaces. Using raw-array indices to drive `arrayMove` on a flat
 * rendered drag was the source of the "swap adjacent items across
 * workspace boundary" bug.
 *
 * Returning a discriminated outcome keeps the React handler thin (it just
 * fires the side effect named here) and makes the logic testable without
 * dnd-kit or a DOM.
 */
import type { Project } from '@shared/types'

export type DragOutcome =
  | { type: 'noop' }
  | {
      type: 'reassign'
      projectPath: string
      targetWorkspaceId: string | null
      oldIndex: number
      newIndex: number
    }
  | { type: 'reorder'; oldIndex: number; newIndex: number }

export function decideDragOutcome(
  projects: Project[],
  renderedOrder: string[],
  activeId: string,
  overId: string,
): DragOutcome {
  if (activeId === overId) return { type: 'noop' }

  const active = projects.find((p) => p.path === activeId)
  const over = projects.find((p) => p.path === overId)
  if (!active || !over) return { type: 'noop' }

  const oldIndex = renderedOrder.indexOf(activeId)
  const newIndex = renderedOrder.indexOf(overId)
  if (oldIndex === -1 || newIndex === -1) return { type: 'noop' }

  const activeWs = active.workspaceId ?? null
  const overWs = over.workspaceId ?? null
  if (activeWs !== overWs) {
    return {
      type: 'reassign',
      projectPath: active.path,
      targetWorkspaceId: overWs,
      oldIndex,
      newIndex,
    }
  }
  return { type: 'reorder', oldIndex, newIndex }
}
