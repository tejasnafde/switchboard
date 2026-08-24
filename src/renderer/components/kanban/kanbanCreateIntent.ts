import type { KanbanCardCreate, KanbanStatus } from '../../../shared/kanban'
import type { RuntimeMode } from '../../../shared/provider-events'

interface KanbanCardCreateFields {
  projectPath: string
  title: string
  description: string
  tags: string[]
  status?: KanbanStatus
  costCapUsd: number | null
  runtimeMode: RuntimeMode
  withWorktree: boolean
}

function initialPrompt(title: string, description: string): string {
  const cleanTitle = title.trim()
  const cleanDescription = description.trim()
  if (cleanTitle && cleanDescription) return `${cleanTitle}\n\n${cleanDescription}`
  return cleanTitle || cleanDescription || 'Start working on this card.'
}

export function buildKanbanCardCreateSubmission(
  fields: KanbanCardCreateFields,
): KanbanCardCreate {
  return {
    projectPath: fields.projectPath,
    title: fields.title,
    description: fields.description,
    tags: fields.tags,
    status: fields.status,
    costCapUsd: fields.costCapUsd,
    runtimeMode: fields.runtimeMode,
    withWorktree: fields.withWorktree,
    ...(fields.withWorktree
      ? {
          worktreeCreation: {
            initialAgent: {
              provider: 'claude-code' as const,
              runtimeMode: fields.runtimeMode,
              prompt: initialPrompt(fields.title, fields.description),
            },
          },
        }
      : {}),
  }
}
