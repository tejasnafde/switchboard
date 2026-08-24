import type { BackendHost } from '../backend/host'
import { WorktreeCreationChannels } from '../../shared/ipc-channels'
import { authorizeWorktreeCreationRequest } from '../worktree-creation/authorization'
import {
  parseWorktreeCreationRequest,
  type GetWorktreeCreationRequest,
  type WorktreeCreationActionRequest,
  type WorktreeCreationProgressEvent,
  type WorktreeCreationRequest,
  type WorktreeCreationSnapshot,
} from '../../shared/worktree-creation'

export interface WorktreeCreationApi {
  createWorktreeTransaction(input: unknown): Promise<WorktreeCreationSnapshot>
  getWorktreeCreation(input: GetWorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
  actOnWorktreeCreation(input: WorktreeCreationActionRequest): Promise<WorktreeCreationSnapshot>
}

export interface RetargetableWorktreeCreationProgressSink {
  publish(event: WorktreeCreationProgressEvent): void
  registerHost(host: BackendHost): void
}

export function createWorktreeCreationProgressSink(
  initialHost: BackendHost,
): RetargetableWorktreeCreationProgressSink {
  let host = initialHost
  return {
    publish(event): void {
      host.emit(WorktreeCreationChannels.PROGRESS, event)
    },
    registerHost(nextHost): void {
      host = nextHost
    },
  }
}

function validatedCreateRequest(input: unknown): WorktreeCreationRequest {
  const parsed = parseWorktreeCreationRequest(input)
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((issue) => issue.message).join(' '))
  }
  return authorizeWorktreeCreationRequest(parsed.value)
}

export function registerWorktreeCreationHandlers(
  host: BackendHost,
  service: WorktreeCreationApi,
): void {
  host.handle(WorktreeCreationChannels.CREATE, async (input: unknown) =>
    service.createWorktreeTransaction(validatedCreateRequest(input)))
  host.handle(WorktreeCreationChannels.GET, (input: GetWorktreeCreationRequest) =>
    service.getWorktreeCreation(input))
  host.handle(WorktreeCreationChannels.ACT, (input: WorktreeCreationActionRequest) =>
    service.actOnWorktreeCreation(input))
}
