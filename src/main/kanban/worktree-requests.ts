import type {
  KanbanCard,
  KanbanCardCreate,
  KanbanWorktreeCreationIntent,
} from '../../shared/kanban'
import type { WorktreeCreationRequest } from '../../shared/worktree-creation'

function identity(
  intent: KanbanWorktreeCreationIntent | undefined,
  createId: () => string,
  now: () => number,
) {
  return {
    creationId: intent?.creationId ?? createId(),
    machineId: intent?.machineId ?? 'local',
    requestedAt: intent?.requestedAt ?? now(),
    baseRef: intent?.baseRef ?? 'HEAD',
    setupPolicy: intent?.setupPolicy ?? 'inherit',
  } as const
}

export function buildNewCardWorktreeRequest(input: {
  cardId: string
  card: KanbanCardCreate
  createId: () => string
  now: () => number
}): WorktreeCreationRequest {
  const ids = identity(input.card.worktreeCreation, input.createId, input.now)
  return {
    schemaVersion: 1,
    creationId: ids.creationId,
    repository: { projectPath: input.card.projectPath, machineId: ids.machineId },
    checkout: {
      baseRef: ids.baseRef,
      branch: { namespace: 'kanban', seed: input.card.title },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'kanban-card',
      cardId: input.cardId,
      create: {
        title: input.card.title,
        description: input.card.description ?? '',
        tags: input.card.tags ?? [],
        status: input.card.status ?? 'backlog',
        runtimeMode: input.card.runtimeMode,
        costCapUsd: input.card.costCapUsd ?? null,
      },
    },
    purpose: 'kanban',
    setup: { policy: ids.setupPolicy },
    ...(input.card.worktreeCreation?.initialAgent
      ? { launch: { initialAgent: input.card.worktreeCreation.initialAgent } }
      : {}),
    provenance: {
      surface: 'desktop',
      machineId: ids.machineId,
      requestedAt: ids.requestedAt,
    },
  }
}

export function buildExistingCardWorktreeRequest(input: {
  card: KanbanCard
  intent?: KanbanWorktreeCreationIntent
  createId: () => string
  now: () => number
}): WorktreeCreationRequest {
  const ids = identity(input.intent, input.createId, input.now)
  return {
    schemaVersion: 1,
    creationId: ids.creationId,
    repository: { projectPath: input.card.projectPath, machineId: ids.machineId },
    checkout: {
      baseRef: ids.baseRef,
      branch: { namespace: 'kanban', seed: input.card.title },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'kanban-card',
      cardId: input.card.id,
      expectedRevision: input.card.updatedAt,
    },
    purpose: 'kanban',
    setup: { policy: ids.setupPolicy },
    ...(input.intent?.initialAgent ? { launch: { initialAgent: input.intent.initialAgent } } : {}),
    provenance: {
      surface: 'desktop',
      machineId: ids.machineId,
      requestedAt: ids.requestedAt,
    },
  }
}
