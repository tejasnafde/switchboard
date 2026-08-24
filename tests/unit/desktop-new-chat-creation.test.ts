import { describe, expect, it, vi } from 'vitest'
import type {
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '../../src/shared/worktree-creation'
import {
  createDesktopNewChatCoordinator,
  retainedWorktreeCreationKey,
  retryDesktopWorktreeCreation,
  shouldDismissDesktopWorktreeSnapshot,
  type DesktopNewChatIntent,
} from '../../src/renderer/services/desktopNewChatCreation'

const intent: DesktopNewChatIntent = {
  projectPath: '/repo',
  machineId: 'machine-1',
  checkout: 'worktree',
  agentType: 'claude-code',
  runtimeMode: 'sandbox',
}

function ready(request: WorktreeCreationRequest): WorktreeCreationSnapshot {
  return {
    creationId: request.creationId,
    revision: 7,
    phase: 'ready',
    status: 'ready',
    worktreeId: 'worktree-1',
    projectPath: '/repo',
    worktreePath: '/managed/repo/thread-1',
    branch: 'sb/thread-1',
    baseRef: 'HEAD',
    owner: request.owner,
    purpose: 'new-chat',
    provenance: request.provenance,
    setupReceipt: {
      requestedPolicy: 'inherit',
      resolvedPolicy: 'skip',
      status: 'skipped',
    },
    startupReceipt: {
      status: 'succeeded',
      terminalIds: ['managed-terminal-1', 'managed-terminal-2'],
      providerThreadId: request.owner.kind === 'conversation'
        ? request.owner.conversationId
        : undefined,
    },
    warnings: [],
    recoveryActions: [],
    updatedAt: 101,
  }
}

function fixture(createImpl?: (request: WorktreeCreationRequest) => Promise<WorktreeCreationSnapshot>) {
  let progress: ((event: WorktreeCreationProgressEvent) => void) | null = null
  const worktrees = {
    create: vi.fn(createImpl ?? (async (request) => ready(request))),
    get: vi.fn(async ({ creationId }: { creationId: string; machineId: string }) => {
      const request = worktrees.create.mock.calls[0]?.[0] as WorktreeCreationRequest
      return ready({ ...request, creationId })
    }),
    onProgress: vi.fn((listener: (event: WorktreeCreationProgressEvent) => void) => {
      progress = listener
      return () => { progress = null }
    }),
  }
  const sessions = { addAuthoritative: vi.fn() }
  const parent = { create: vi.fn(async () => ({ conversationId: 'parent-conversation' })) }
  const journalEntries = new Map<string, { intent: DesktopNewChatIntent; request: WorktreeCreationRequest }>()
  const journal = {
    save: vi.fn((entry: { intent: DesktopNewChatIntent; request: WorktreeCreationRequest }) => {
      journalEntries.set(entry.request.creationId, entry)
    }),
    remove: vi.fn((creationId: string) => { journalEntries.delete(creationId) }),
  }
  const stateChanges: string[] = []
  const coordinator = createDesktopNewChatCoordinator({
    worktrees,
    sessions,
    parent,
    journal,
    createId: (() => {
      const ids = ['creation-1', 'conversation-1', 'parent-creation-2', 'parent-conversation-2']
      return () => ids.shift()!
    })(),
    now: () => 100,
    onStateChange: (state) => stateChanges.push(`${state.status}:${state.detail ?? ''}`),
  })
  return {
    coordinator,
    worktrees,
    sessions,
    parent,
    journal,
    journalEntries,
    stateChanges,
    emit: (event: WorktreeCreationProgressEvent) => progress?.(event),
  }
}

describe('Desktop new-chat worktree transaction', () => {
  it('dismisses removed, cancelled, and actionless terminal snapshots but keeps retained recovery reachable', () => {
    const base = {
      creationId: 'creation-terminal',
      revision: 8,
      phase: 'provisioning' as const,
      projectPath: '/repo',
      worktreePath: '/managed/repo/thread-1',
      branch: 'sb/thread-1',
      baseRef: 'HEAD',
      owner: { kind: 'conversation' as const, conversationId: 'conversation-1', agentType: 'claude-code' as const },
      purpose: 'new-chat' as const,
      provenance: { surface: 'desktop' as const, machineId: 'machine-1', requestedAt: 100 },
      warnings: [],
      updatedAt: 101,
    }

    expect(shouldDismissDesktopWorktreeSnapshot({
      ...base,
      status: 'rolled_back',
      cleanupDisposition: 'removed',
      recoveryActions: [],
    })).toBe(true)
    expect(shouldDismissDesktopWorktreeSnapshot({
      ...base,
      status: 'cancelled',
      recoveryActions: [],
    })).toBe(true)
    expect(shouldDismissDesktopWorktreeSnapshot({
      ...base,
      status: 'failed',
      recoveryActions: [],
    })).toBe(true)
    expect(shouldDismissDesktopWorktreeSnapshot({
      ...base,
      status: 'cleanup_required',
      cleanupDisposition: 'retained',
      recoveryActions: ['remove'],
    })).toBe(false)
    expect(shouldDismissDesktopWorktreeSnapshot({
      ...base,
      status: 'pending',
      recoveryActions: [],
    })).toBe(false)
  })

  it('projects only retained worktree conversations into a recovery lookup', () => {
    expect(retainedWorktreeCreationKey({
      id: 'conversation-1',
      source: 'claude-code',
      title: 'Recover this workspace',
      startedAt: 100,
      messageCount: 0,
      filePath: '',
      worktreeCreationId: 'creation-1',
      worktreeRecovery: {
        status: 'cleanup_required',
        cleanupDisposition: 'retained',
      },
    }, 'machine-1')).toEqual({ creationId: 'creation-1', machineId: 'machine-1' })

    expect(retainedWorktreeCreationKey({
      id: 'conversation-2',
      source: 'claude-code',
      title: 'Ready',
      startedAt: 100,
      messageCount: 0,
      filePath: '',
      worktreeCreationId: 'creation-2',
    }, 'machine-1')).toBeNull()
  })

  it('reconciles a local revision-zero retry instead of sending an action for a missing backend record', async () => {
    expect(typeof retryDesktopWorktreeCreation).toBe('function')
    const reconcile = vi.fn(async () => ({ status: 'pending' as const }))
    const act = vi.fn()

    await expect(retryDesktopWorktreeCreation({
      snapshot: {
        creationId: 'creation-local',
        revision: 0,
        phase: 'pending',
        status: 'failed',
        projectPath: '/repo',
        baseRef: 'HEAD',
        owner: { kind: 'conversation', conversationId: 'conversation-local', agentType: 'claude-code' },
        purpose: 'new-chat',
        provenance: { surface: 'desktop', machineId: 'machine-1', requestedAt: 100 },
        warnings: [],
        recoveryActions: ['retry'],
        updatedAt: 100,
      },
      action: 'retry',
      reconcile,
      act,
    })).resolves.toEqual({ status: 'pending' })

    expect(reconcile).toHaveBeenCalledOnce()
    expect(act).not.toHaveBeenCalled()
  })

  it('uses revision-checked backend actions for durable creation snapshots', async () => {
    expect(typeof retryDesktopWorktreeCreation).toBe('function')
    const reconcile = vi.fn()
    const act = vi.fn(async () => ({ status: 'ready' as const }))

    await expect(retryDesktopWorktreeCreation({
      snapshot: {
        creationId: 'creation-durable',
        revision: 4,
        phase: 'materializing',
        status: 'failed',
        projectPath: '/repo',
        baseRef: 'HEAD',
        owner: { kind: 'conversation', conversationId: 'conversation-durable', agentType: 'claude-code' },
        purpose: 'new-chat',
        provenance: { surface: 'desktop', machineId: 'machine-1', requestedAt: 100 },
        warnings: [],
        recoveryActions: ['retry'],
        updatedAt: 100,
      },
      action: 'retry',
      reconcile,
      act,
    })).resolves.toEqual({ status: 'ready' })

    expect(reconcile).not.toHaveBeenCalled()
    expect(act).toHaveBeenCalledWith({
      creationId: 'creation-durable',
      machineId: 'machine-1',
      expectedRevision: 4,
      action: 'retry',
    })
  })

  it('submits one typed backend intent and exposes a session only from the authoritative ready result', async () => {
    const harness = fixture()

    const result = await harness.coordinator.start(intent)

    expect(harness.worktrees.create).toHaveBeenCalledOnce()
    expect(harness.worktrees.create.mock.calls[0]).toHaveLength(1)
    expect(harness.worktrees.create.mock.calls[0][0]).toMatchObject({
      creationId: 'creation-1',
      repository: { projectPath: '/repo', machineId: 'machine-1' },
      owner: {
        kind: 'conversation',
        conversationId: 'conversation-1',
        agentType: 'claude-code',
      },
      setup: { policy: 'inherit' },
      launch: {
        initialAgent: {
          provider: 'claude-code',
          runtimeMode: 'sandbox',
        },
      },
    })
    expect(harness.sessions.addAuthoritative).toHaveBeenCalledWith({
      id: 'conversation-1',
      type: 'claude-code',
      status: 'idle',
      projectPath: '/repo',
      machineId: 'machine-1',
      worktreeId: 'worktree-1',
      worktreePath: '/managed/repo/thread-1',
      worktreeBranch: 'sb/thread-1',
      title: 'New conversation',
      runtimeMode: 'sandbox',
      managedTerminalIds: ['managed-terminal-1', 'managed-terminal-2'],
    })
    expect(result.status).toBe('ready')
    expect(harness.parent.create).not.toHaveBeenCalled()
  })

  it('keeps the exact creation identity pending on ambiguous transport failure and reconciles with GET', async () => {
    const harness = fixture(async () => { throw new Error('socket closed') })
    harness.worktrees.get.mockRejectedValueOnce(new Error('socket closed'))

    await expect(harness.coordinator.start(intent)).resolves.toMatchObject({
      status: 'reconciling',
      creationId: 'creation-1',
      conversationId: 'conversation-1',
      snapshot: { status: 'pending', recoveryActions: ['retry'] },
    })
    expect(harness.sessions.addAuthoritative).not.toHaveBeenCalled()

    const result = await harness.coordinator.reconcile()

    expect(harness.worktrees.get).toHaveBeenCalledWith({
      creationId: 'creation-1',
      machineId: 'machine-1',
    })
    expect(result.status).toBe('ready')
    expect(harness.sessions.addAuthoritative).toHaveBeenCalledOnce()
  })

  it('persists before submission and restores the exact request after a crash before backend reservation', async () => {
    const first = fixture(async () => { throw new Error('renderer closed') })
    first.worktrees.get.mockRejectedValueOnce(new Error('Unknown worktree creation creation-1.'))
    const pending = await first.coordinator.start(intent)
    const entry = first.journalEntries.get(pending.creationId!)!
    expect(first.journal.save).toHaveBeenCalledBefore(first.worktrees.create)

    const restored = fixture()
    restored.worktrees.get.mockRejectedValueOnce(new Error(`Unknown worktree creation ${entry.request.creationId}.`))
    const result = await restored.coordinator.restore(entry)

    expect(restored.worktrees.get).toHaveBeenCalledWith({
      creationId: entry.request.creationId,
      machineId: entry.request.repository.machineId,
    })
    expect(restored.worktrees.create).toHaveBeenCalledWith(entry.request)
    expect(result.status).toBe('ready')
    expect(restored.sessions.addAuthoritative).toHaveBeenCalledOnce()
  })

  it('does not create a sent-looking session for a durable failure and surfaces correlated progress', async () => {
    let request!: WorktreeCreationRequest
    const harness = fixture(async (input) => {
      request = input
      return {
        ...ready(input),
        revision: 3,
        phase: 'materializing',
        status: 'failed',
        worktreeId: undefined,
        worktreePath: undefined,
        branch: undefined,
        startupReceipt: undefined,
        error: {
          code: 'branch_exists',
          phase: 'materializing',
          message: 'The branch was not created.',
          retryable: true,
        },
        recoveryActions: ['retry', 'start_in_project'],
      }
    })

    const result = await harness.coordinator.start(intent)
    harness.emit({
      creationId: request.creationId,
      revision: 4,
      phase: 'materializing',
      status: 'failed',
      timestamp: 104,
      detail: 'The branch was not created.',
      recoveryActions: ['retry', 'start_in_project'],
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: 'The branch was not created.',
    })
    expect(harness.coordinator.state()).toMatchObject({
      creationId: 'creation-1',
      detail: 'The branch was not created.',
    })
    expect(harness.stateChanges).toContain('failed:The branch was not created.')
    expect(harness.sessions.addAuthoritative).not.toHaveBeenCalled()
    expect(harness.parent.create).not.toHaveBeenCalled()
  })

  it('clears the local journal when the backend returns an actionless terminal failure', async () => {
    const harness = fixture(async (input) => ({
      ...ready(input),
      phase: 'materializing',
      status: 'failed',
      worktreeId: undefined,
      worktreePath: undefined,
      branch: undefined,
      startupReceipt: undefined,
      error: {
        code: 'invalid_repository',
        phase: 'materializing',
        message: 'The branch was not created.',
        retryable: false,
      },
      recoveryActions: [],
    }))

    const result = await harness.coordinator.start(intent)

    expect(result).toMatchObject({ status: 'failed', snapshot: { recoveryActions: [] } })
    expect(harness.journal.remove).toHaveBeenCalledWith('creation-1')
    expect(harness.journalEntries).toHaveLength(0)
  })

  it('shows a definite pre-reservation rejection with explicit retry and parent fallback', async () => {
    const harness = fixture(async () => { throw new Error('Invalid base ref.') })
    harness.worktrees.get.mockRejectedValueOnce(new Error('Unknown worktree creation creation-1.'))

    const result = await harness.coordinator.start(intent)

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Invalid base ref.',
      snapshot: {
        status: 'failed',
        recoveryActions: ['retry', 'start_in_project'],
      },
    })
    expect(harness.sessions.addAuthoritative).not.toHaveBeenCalled()
  })

  it('starts in the parent checkout only as an explicit fresh user action', async () => {
    const harness = fixture(async (input) => ({
      ...ready(input),
      phase: 'materializing',
      status: 'failed',
      worktreeId: undefined,
      worktreePath: undefined,
      branch: undefined,
      startupReceipt: undefined,
      error: {
        code: 'permission_denied',
        phase: 'materializing',
        message: 'The branch was not created.',
        retryable: false,
      },
      recoveryActions: ['start_in_project'],
    }))
    await harness.coordinator.start(intent)

    await harness.coordinator.startInProject()

    expect(harness.parent.create).toHaveBeenCalledOnce()
    expect(harness.parent.create).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo',
      machineId: 'machine-1',
      agentType: 'claude-code',
      runtimeMode: 'sandbox',
      conversationId: 'parent-conversation-2',
    }))
  })
})
