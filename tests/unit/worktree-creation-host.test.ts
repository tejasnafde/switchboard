import { describe, expect, it, vi } from 'vitest'
import type { BackendHost } from '../../src/main/backend/host'
import {
  createWorktreeCreationProgressSink,
  registerWorktreeCreationHandlers,
} from '../../src/main/ipc/worktree-creation'
import { WorktreeCreationChannels } from '../../src/shared/ipc-channels'
import { withBackendRequestContext } from '../../src/main/backend/request-context'
import type {
  GetWorktreeCreationRequest,
  WorktreeCreationActionRequest,
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

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'create-host-1',
    repository: {
      projectPath: '/projects/switchboard',
      machineId: 'machine-remote-2',
    },
    checkout: {
      baseRef: 'main',
      branch: { namespace: 'sb', seed: 'host-api' },
      location: 'managed-user-data',
    },
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-host-1',
      agentType: 'claude-code',
      title: 'Host API',
    },
    purpose: 'new-chat',
    setup: { policy: 'skip' },
    provenance: {
      surface: 'react-native',
      machineId: 'machine-remote-2',
      requestedAt: 1_777_000_000_000,
    },
    ...overrides,
  }
}

function snapshot(overrides: Partial<WorktreeCreationSnapshot> = {}): WorktreeCreationSnapshot {
  return {
    creationId: 'create-host-1',
    revision: 4,
    phase: 'ready',
    status: 'ready',
    worktreeId: 'worktree-host-1',
    projectPath: '/canonical/switchboard',
    worktreePath: '/managed/switchboard/host-api',
    branch: 'sb/host-api-create-host',
    baseRef: 'main',
    owner: request().owner,
    purpose: 'new-chat',
    provenance: request().provenance,
    warnings: [],
    recoveryActions: [],
    updatedAt: 1_777_000_000_004,
    ...overrides,
  }
}

function setup() {
  const host = new FakeHost()
  const service = {
    createWorktreeTransaction: vi.fn().mockResolvedValue(snapshot()),
    getWorktreeCreation: vi.fn().mockResolvedValue(snapshot()),
    actOnWorktreeCreation: vi.fn().mockResolvedValue(snapshot({ status: 'cancelled' })),
  }
  registerWorktreeCreationHandlers(host, service)
  return { host, service }
}

describe('worktree creation BackendHost API', () => {
  it('registers typed CREATE, GET, and ACT handlers and forwards one envelope to each service method', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!
    const get = host.handlers.get(WorktreeCreationChannels.GET)!
    const act = host.handlers.get(WorktreeCreationChannels.ACT)!
    const createRequest = request()
    const getRequest: GetWorktreeCreationRequest = {
      creationId: createRequest.creationId,
      machineId: createRequest.repository.machineId,
    }
    const actionRequest: WorktreeCreationActionRequest = {
      ...getRequest,
      expectedRevision: 4,
      action: 'cancel',
    }

    await expect(create(createRequest)).resolves.toEqual(snapshot())
    await expect(get(getRequest)).resolves.toEqual(snapshot())
    await expect(act(actionRequest)).resolves.toEqual(snapshot({ status: 'cancelled' }))

    expect([...host.handlers.keys()].sort()).toEqual([
      WorktreeCreationChannels.ACT,
      WorktreeCreationChannels.CREATE,
      WorktreeCreationChannels.GET,
    ].sort())
    expect(service.createWorktreeTransaction).toHaveBeenCalledOnce()
    expect(service.createWorktreeTransaction).toHaveBeenCalledWith(createRequest)
    expect(service.getWorktreeCreation).toHaveBeenCalledOnce()
    expect(service.getWorktreeCreation).toHaveBeenCalledWith(getRequest)
    expect(service.actOnWorktreeCreation).toHaveBeenCalledOnce()
    expect(service.actOnWorktreeCreation).toHaveBeenCalledWith(actionRequest)
  })

  it('rejects a repository/provenance machine mismatch before calling the service', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!
    const mismatched = request({
      provenance: {
        ...request().provenance,
        machineId: 'machine-other-3',
      },
    })

    await expect(create(mismatched)).rejects.toThrow(/machine/i)
    expect(service.createWorktreeTransaction).not.toHaveBeenCalled()
  })

  it('routes creation by the explicit machine identity without a conversation or positional Git route', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!
    const explicitMachineRequest = request({
      repository: {
        projectPath: '/projects/remote-repository',
        machineId: 'machine-explicit-9',
      },
      provenance: {
        surface: 'desktop',
        machineId: 'machine-explicit-9',
        requestedAt: 1_777_000_000_010,
      },
    })

    await create(explicitMachineRequest)

    expect(service.createWorktreeTransaction).toHaveBeenCalledWith(explicitMachineRequest)
    expect(service.createWorktreeTransaction.mock.calls[0]).toHaveLength(1)

    service.createWorktreeTransaction.mockClear()
    await expect(create('/projects/remote-repository', 'main', 'host-api'))
      .rejects.toThrow()
    expect(service.createWorktreeTransaction).not.toHaveBeenCalled()
  })

  it('rejects setup and ad-hoc startup commands for a chat-only remote before mutation', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!

    await expect(withBackendRequestContext(
      { clientScope: 'device-session:test', transport: 'remote', deviceScopes: ['chat'] },
      () => create(request({ launch: { startupCommand: 'touch /tmp/should-not-run' } })),
    )).rejects.toThrow(/terminal.*scope/i)

    await expect(withBackendRequestContext(
      { clientScope: 'device-session:test', transport: 'remote', deviceScopes: ['chat'] },
      () => create(request({ setup: { policy: 'run' } })),
    )).rejects.toThrow(/setup.*terminal.*scope/i)

    expect(service.createWorktreeTransaction).not.toHaveBeenCalled()
  })

  it('persists a no-terminal policy while allowing a chat-scoped remote initial agent and prompt', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!
    const remote = request({
      launch: {
        launchConfigName: 'development',
        initialAgent: { provider: 'claude-code', prompt: 'Start once.' },
      },
    })

    await withBackendRequestContext(
      { clientScope: 'device-session:test', transport: 'remote', deviceScopes: ['chat'] },
      () => create(remote),
    )

    expect(service.createWorktreeTransaction).toHaveBeenCalledWith({
      ...remote,
      launch: {
        ...remote.launch,
        terminalPolicy: 'skip',
      },
    })
  })

  it('allows terminal-scoped remote setup and startup while persisting that authority', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!
    const remote = request({
      setup: { policy: 'run' },
      launch: { startupCommand: 'npm run dev' },
    })

    await withBackendRequestContext(
      { clientScope: 'device-session:test', transport: 'remote', deviceScopes: ['chat', 'terminal'] },
      () => create(remote),
    )

    expect(service.createWorktreeTransaction).toHaveBeenCalledWith({
      ...remote,
      launch: {
        ...remote.launch,
        terminalPolicy: 'provision',
      },
    })
  })

  it('allows the trusted local renderer to submit an explicit startup command', async () => {
    const { host, service } = setup()
    const create = host.handlers.get(WorktreeCreationChannels.CREATE)!
    const local = request({ launch: { startupCommand: 'npm run dev' } })

    await withBackendRequestContext(
      { clientScope: 'electron:local', transport: 'electron' },
      () => create(local),
    )

    expect(service.createWorktreeTransaction).toHaveBeenCalledWith({
      ...local,
      launch: { ...local.launch, terminalPolicy: 'provision' },
    })
  })

  it('publishes correlated progress through WorktreeCreationChannels.PROGRESS', () => {
    const host = new FakeHost()
    const sink = createWorktreeCreationProgressSink(host)
    const event: WorktreeCreationProgressEvent = {
      creationId: 'create-host-1',
      revision: 2,
      phase: 'materializing',
      status: 'pending',
      timestamp: 1_777_000_000_002,
      detail: 'Creating the managed checkout',
      recoveryActions: [],
    }

    sink.publish(event)

    expect(host.events).toEqual([{
      channel: WorktreeCreationChannels.PROGRESS,
      args: [event],
    }])
  })
})
