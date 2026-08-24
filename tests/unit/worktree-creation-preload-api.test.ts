import { describe, expect, it, vi } from 'vitest'
import { createWorktreeCreationApi } from '../../src/preload/worktree-creation-api'
import { WorktreeCreationChannels } from '../../src/shared/ipc-channels'
import type { Transport } from '../../src/shared/transport'
import type {
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
} from '../../src/shared/worktree-creation'

const request: WorktreeCreationRequest = {
  schemaVersion: 1,
  creationId: 'create-preload-1',
  repository: { projectPath: '/repo', machineId: 'machine-remote-1' },
  checkout: { baseRef: 'main', branch: { namespace: 'sb', seed: 'preload' } },
  owner: {
    kind: 'conversation',
    conversationId: 'conversation-preload-1',
    agentType: 'codex',
  },
  purpose: 'new-chat',
  setup: { policy: 'skip' },
  provenance: {
    surface: 'desktop',
    machineId: 'machine-remote-1',
    requestedAt: 1_777_000_000_000,
  },
}

describe('preload worktree creation API', () => {
  it('uses typed envelopes for create, get, and act', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'pending' })
    const transport: Transport = {
      invoke,
      send: vi.fn(),
      on: vi.fn(() => () => undefined),
    }
    const api = createWorktreeCreationApi(transport)
    const key = { creationId: request.creationId, machineId: request.repository.machineId }
    const action = { ...key, expectedRevision: 1, action: 'cancel' as const }

    await api.create(request)
    await api.get(key)
    await api.act(action)

    expect(invoke).toHaveBeenNthCalledWith(1, WorktreeCreationChannels.CREATE, request)
    expect(invoke).toHaveBeenNthCalledWith(2, WorktreeCreationChannels.GET, key)
    expect(invoke).toHaveBeenNthCalledWith(3, WorktreeCreationChannels.ACT, action)
  })

  it('subscribes and disposes correlated progress events', () => {
    let listener: ((event: WorktreeCreationProgressEvent) => void) | undefined
    const dispose = vi.fn()
    const transport: Transport = {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn((_channel, handler) => {
        listener = handler as (event: WorktreeCreationProgressEvent) => void
        return dispose
      }),
    }
    const callback = vi.fn()
    const api = createWorktreeCreationApi(transport)
    const event: WorktreeCreationProgressEvent = {
      creationId: request.creationId,
      revision: 1,
      phase: 'pending',
      status: 'pending',
      timestamp: 1_777_000_000_001,
      recoveryActions: ['cancel'],
    }

    const off = api.onProgress(callback)
    listener?.(event)
    off()

    expect(transport.on).toHaveBeenCalledWith(WorktreeCreationChannels.PROGRESS, expect.any(Function))
    expect(callback).toHaveBeenCalledWith(event)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
