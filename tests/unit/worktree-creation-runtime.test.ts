import { describe, expect, it, vi } from 'vitest'
import type { BackendHost } from '../../src/main/backend/host'
import { createWorktreeCreationRuntime } from '../../src/main/worktree-creation/runtime'
import { WorktreeCreationChannels } from '../../src/shared/ipc-channels'
import type {
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '../../src/shared/worktree-creation'

class FakeHost implements BackendHost {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  readonly events: Array<{ channel: string; args: unknown[] }> = []

  handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }

  on(): void {}

  emit(channel: string, ...args: unknown[]): void {
    this.events.push({ channel, args })
  }
}

const creationRequest: WorktreeCreationRequest = {
  schemaVersion: 1,
  creationId: 'create-runtime-1',
  repository: { projectPath: '/repo', machineId: 'machine-local-1' },
  checkout: {
    baseRef: 'main',
    branch: { namespace: 'sb', seed: 'runtime' },
  },
  owner: {
    kind: 'conversation',
    conversationId: 'conversation-runtime-1',
    agentType: 'codex',
  },
  purpose: 'new-chat',
  setup: { policy: 'skip' },
  provenance: {
    surface: 'desktop',
    machineId: 'machine-local-1',
    requestedAt: 1_777_000_000_000,
  },
}

const creationSnapshot: WorktreeCreationSnapshot = {
  creationId: creationRequest.creationId,
  revision: 1,
  phase: 'pending',
  status: 'pending',
  projectPath: creationRequest.repository.projectPath,
  baseRef: creationRequest.checkout.baseRef,
  owner: creationRequest.owner,
  purpose: creationRequest.purpose,
  provenance: creationRequest.provenance,
  warnings: [],
  recoveryActions: ['cancel'],
  updatedAt: 1_777_000_000_001,
}

describe('worktree creation process runtime', () => {
  it('keeps one service while retargeting handlers and progress to a reactivated host', async () => {
    const initialHost = new FakeHost()
    const replacementHost = new FakeHost()
    let publishProgress: ((event: WorktreeCreationProgressEvent) => void) | undefined
    const service = {
      createWorktreeTransaction: vi.fn().mockResolvedValue(creationSnapshot),
      getWorktreeCreation: vi.fn().mockResolvedValue(creationSnapshot),
      actOnWorktreeCreation: vi.fn().mockResolvedValue(creationSnapshot),
    }
    const createService = vi.fn(async (sink: { publish(event: WorktreeCreationProgressEvent): void }) => {
      publishProgress = (event) => sink.publish(event)
      return service
    })

    const runtime = createWorktreeCreationRuntime(initialHost, createService)
    runtime.registerHost(replacementHost)

    await expect(runtime.createWorktreeTransaction(creationRequest)).resolves.toEqual(creationSnapshot)

    const create = replacementHost.handlers.get(WorktreeCreationChannels.CREATE)!
    await expect(create(creationRequest)).resolves.toEqual(creationSnapshot)
    expect(createService).toHaveBeenCalledOnce()
    expect(service.createWorktreeTransaction).toHaveBeenCalledTimes(2)

    const event: WorktreeCreationProgressEvent = {
      creationId: creationRequest.creationId,
      revision: 1,
      phase: 'pending',
      status: 'pending',
      timestamp: 1_777_000_000_001,
      recoveryActions: ['cancel'],
    }
    publishProgress?.(event)

    expect(initialHost.events).toEqual([])
    expect(replacementHost.events).toEqual([{
      channel: WorktreeCreationChannels.PROGRESS,
      args: [event],
    }])
  })
})
