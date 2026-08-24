import { describe, expect, it, vi } from 'vitest'
import type {
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '../../src/shared/worktree-creation'
import { createNewSessionCreationCoordinator } from '../../apps/mobile/src/lib/newSessionCreation'

const worktreeIntent = {
  connectionId: 'connection-1',
  machineId: 'machine-1',
  projectPath: '/projects/switchboard',
  projectName: 'Switchboard',
  checkout: {
    kind: 'worktree' as const,
    baseRef: 'main',
    branchSeed: 'fix-mobile-launch',
    setupPolicy: 'skip' as const,
  },
  conversation: {
    id: 'mob-thread-1',
    agentType: 'claude-code' as const,
  },
  provider: {
    instanceId: 'claude-team',
    model: 'sonnet',
    runtimeMode: 'sandbox' as const,
  },
  firstMessage: 'Fix the launch transaction.',
}

function snapshot(
  overrides: Partial<WorktreeCreationSnapshot> = {},
): WorktreeCreationSnapshot {
  return {
    creationId: 'create-mobile-1',
    revision: 1,
    phase: 'pending',
    status: 'pending',
    projectPath: '/canonical/switchboard',
    baseRef: 'main',
    owner: {
      kind: 'conversation',
      conversationId: 'mob-thread-1',
      agentType: 'claude-code',
    },
    purpose: 'new-chat',
    provenance: {
      surface: 'react-native',
      machineId: 'machine-1',
      requestedAt: 1_777_000_000_000,
    },
    warnings: [],
    recoveryActions: [],
    updatedAt: 1_777_000_000_001,
    ...overrides,
  }
}

function readySnapshot(): WorktreeCreationSnapshot {
  return snapshot({
    revision: 4,
    phase: 'ready',
    status: 'ready',
    worktreeId: 'worktree-mobile-1',
    worktreePath: '/managed/switchboard/fix-mobile-launch',
    branch: 'sb/fix-mobile-launch-create-mob',
    updatedAt: 1_777_000_000_004,
  })
}

function harness(options: {
  createResult?: WorktreeCreationSnapshot
  getResult?: WorktreeCreationSnapshot
} = {}) {
  const creationIds = ['create-mobile-1', 'create-parent-2']
  const createWorktree = vi.fn<(
    request: WorktreeCreationRequest,
  ) => Promise<WorktreeCreationSnapshot>>()
    .mockResolvedValue(options.createResult ?? snapshot())
  const getWorktree = vi.fn()
    .mockResolvedValue(options.getResult ?? snapshot())
  const createParentCheckout = vi.fn()
    .mockResolvedValue({
      creationId: 'create-parent-2',
      threadId: 'mob-thread-1',
      projectPath: '/canonical/switchboard',
      title: 'Switchboard',
    })
  const onReady = vi.fn()

  const coordinator = createNewSessionCreationCoordinator({
    nextCreationId: vi.fn(() => creationIds.shift() ?? 'unexpected-creation-id'),
    now: () => 1_777_000_000_000,
    worktrees: {
      create: createWorktree,
      get: getWorktree,
    },
    parentCheckout: {
      create: createParentCheckout,
    },
    onReady,
  })

  return {
    coordinator,
    createWorktree,
    getWorktree,
    createParentCheckout,
    onReady,
  }
}

describe('React Native new-session creation coordinator', () => {
  it('keeps one creationId and identical worktree payload across a retry', async () => {
    const h = harness()

    await h.coordinator.begin(worktreeIntent)
    await h.coordinator.retry()

    expect(h.createWorktree).toHaveBeenCalledTimes(2)
    expect(h.createWorktree.mock.calls[0][0]).toEqual(h.createWorktree.mock.calls[1][0])
    expect(h.createWorktree.mock.calls[0][0]).toMatchObject({
      schemaVersion: 1,
      creationId: 'create-mobile-1',
      repository: {
        projectPath: '/projects/switchboard',
        machineId: 'machine-1',
      },
      checkout: {
        baseRef: 'main',
        branch: { namespace: 'sb', seed: 'fix-mobile-launch' },
      },
      owner: {
        kind: 'conversation',
        conversationId: 'mob-thread-1',
        agentType: 'claude-code',
      },
      purpose: 'new-chat',
      setup: { policy: 'skip' },
      launch: {
        initialAgent: {
          provider: 'claude-code',
          instanceId: 'claude-team',
          model: 'sonnet',
          runtimeMode: 'sandbox',
          prompt: 'Fix the launch transaction.',
        },
      },
      provenance: {
        surface: 'react-native',
        machineId: 'machine-1',
        requestedAt: 1_777_000_000_000,
      },
    })
    expect(h.createParentCheckout).not.toHaveBeenCalled()
  })

  it('routes an explicit parent-checkout intent without creating a worktree', async () => {
    const h = harness()

    await h.coordinator.begin({
      ...worktreeIntent,
      checkout: { kind: 'parent-checkout' as const },
    })

    expect(h.createWorktree).not.toHaveBeenCalled()
    expect(h.createParentCheckout).toHaveBeenCalledOnce()
    expect(h.createParentCheckout).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'create-mobile-1',
      projectPath: '/projects/switchboard',
      conversation: worktreeIntent.conversation,
      provider: worktreeIntent.provider,
      firstMessage: worktreeIntent.firstMessage,
    }))
  })

  it('queries the durable snapshot with the same creationId after an ambiguous disconnect', async () => {
    const h = harness({ getResult: readySnapshot() })
    h.createWorktree.mockRejectedValueOnce(new Error('transport closed after request was sent'))

    await h.coordinator.begin(worktreeIntent)

    expect(h.coordinator.getState()).toMatchObject({
      creationId: 'create-mobile-1',
      status: 'ambiguous',
      intent: worktreeIntent,
    })
    expect(h.createParentCheckout).not.toHaveBeenCalled()

    await h.coordinator.reconcileAfterReconnect()

    expect(h.getWorktree).toHaveBeenCalledOnce()
    expect(h.getWorktree).toHaveBeenCalledWith({
      creationId: 'create-mobile-1',
      machineId: 'machine-1',
    })
    expect(h.createWorktree).toHaveBeenCalledOnce()
  })

  it('does not navigate until a ready snapshot supplies authoritative metadata', async () => {
    const h = harness({
      createResult: snapshot(),
      getResult: readySnapshot(),
    })

    await h.coordinator.begin(worktreeIntent)

    expect(h.onReady).not.toHaveBeenCalled()
    expect(h.coordinator.getState()).toMatchObject({ status: 'pending' })

    await h.coordinator.reconcileAfterReconnect()

    expect(h.onReady).toHaveBeenCalledOnce()
    expect(h.onReady).toHaveBeenCalledWith({
      connectionId: 'connection-1',
      threadId: 'mob-thread-1',
      title: 'Switchboard',
      projectPath: '/canonical/switchboard',
      worktreePath: '/managed/switchboard/fix-mobile-launch',
      branch: 'sb/fix-mobile-launch-create-mob',
      worktreeId: 'worktree-mobile-1',
      creationId: 'create-mobile-1',
    })
  })

  it('starts in the parent checkout only after a new explicit user action', async () => {
    const failed = snapshot({
      revision: 3,
      phase: 'materializing',
      status: 'failed',
      error: {
        code: 'git_worktree_failed',
        phase: 'materializing',
        message: 'The worktree could not be created.',
        retryable: true,
      },
      recoveryActions: ['retry', 'start_in_project'],
    })
    const h = harness({ createResult: failed })

    await h.coordinator.begin(worktreeIntent)

    expect(h.coordinator.getState()).toMatchObject({
      creationId: 'create-mobile-1',
      status: 'failed',
      intent: worktreeIntent,
    })
    expect(h.createParentCheckout).not.toHaveBeenCalled()
    expect(h.onReady).not.toHaveBeenCalled()

    await h.coordinator.startInProject()

    expect(h.createParentCheckout).toHaveBeenCalledOnce()
    expect(h.createParentCheckout).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'create-parent-2',
      projectPath: '/projects/switchboard',
      firstMessage: 'Fix the launch transaction.',
    }))
    expect(h.coordinator.getState()).toMatchObject({
      creationId: 'create-parent-2',
      status: 'ready',
    })
  })
})
