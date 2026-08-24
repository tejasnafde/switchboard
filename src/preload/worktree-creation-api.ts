import { WorktreeCreationChannels } from '@shared/ipc-channels'
import type { Transport } from '@shared/transport'
import type {
  GetWorktreeCreationRequest,
  WorktreeCreationActionRequest,
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '@shared/worktree-creation'

export function createWorktreeCreationApi(transport: Transport) {
  return {
    create: (request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot> =>
      transport.invoke(WorktreeCreationChannels.CREATE, request),
    get: (request: GetWorktreeCreationRequest): Promise<WorktreeCreationSnapshot> =>
      transport.invoke(WorktreeCreationChannels.GET, request),
    act: (request: WorktreeCreationActionRequest): Promise<WorktreeCreationSnapshot> =>
      transport.invoke(WorktreeCreationChannels.ACT, request),
    onProgress: (callback: (event: WorktreeCreationProgressEvent) => void): (() => void) =>
      transport.on<[WorktreeCreationProgressEvent]>(
        WorktreeCreationChannels.PROGRESS,
        (event) => callback(event),
      ),
  }
}

export type WorktreeCreationPreloadApi = ReturnType<typeof createWorktreeCreationApi>
