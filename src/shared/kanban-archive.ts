/**
 * Kanban "Done = archive" policy. Moving a card into Done archives its
 * linked conversation; moving back out unarchives. Pure + injectable
 * hooks so the rules are unit-testable without SQLite.
 */
import type { KanbanStatus } from './kanban'

export type ArchiveAction = 'archive' | 'unarchive' | 'none'

export function archiveActionForStatusChange(
  prev: KanbanStatus,
  next: KanbanStatus | undefined,
): ArchiveAction {
  if (!next || next === prev) return 'none'
  if (next === 'done') return 'archive'
  if (prev === 'done') return 'unarchive'
  return 'none'
}

export interface ArchiveHooks {
  archive: (conversationId: string) => void
  unarchive: (conversationId: string) => void
}

export function applyKanbanArchiveSideEffect(
  prev: { status: KanbanStatus; conversationId: string | null },
  next: { status?: KanbanStatus },
  hooks: ArchiveHooks,
): void {
  if (!prev.conversationId) return
  const action = archiveActionForStatusChange(prev.status, next.status)
  if (action === 'archive') hooks.archive(prev.conversationId)
  else if (action === 'unarchive') hooks.unarchive(prev.conversationId)
}
