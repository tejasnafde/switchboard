import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationActionRequest, WorktreeCreationSnapshot } from '../../src/shared/worktree-creation'
import {
  createNewSessionCreationCoordinator,
  newSessionCreationActions,
  type MobileNewSessionCreationState,
} from '../../apps/mobile/src/lib/new-session-creation'
import type { MobileNewSessionCreationStorage } from '../../apps/mobile/src/lib/new-session-creation-storage'

const intent = {
  connectionId: 'connection-1',
  machineId: 'machine-1',
  projectPath: '/projects/switchboard',
  projectName: 'Switchboard',
  checkout: { kind: 'worktree' as const, baseRef: 'HEAD', branchSeed: 'switchboard', setupPolicy: 'skip' as const },
  conversation: { id: 'mob-thread-1', agentType: 'claude-code' as const },
  provider: {},
}

function snapshot(overrides: Partial<WorktreeCreationSnapshot> = {}): WorktreeCreationSnapshot {
  return {
    creationId: 'create-1',
    revision: 1,
    phase: 'pending',
    status: 'pending',
    projectPath: '/projects/switchboard',
    baseRef: 'HEAD',
    owner: { kind: 'conversation', conversationId: 'mob-thread-1', agentType: 'claude-code' },
    purpose: 'new-chat',
    provenance: { surface: 'react-native', machineId: 'machine-1', requestedAt: 1 },
    warnings: [],
    recoveryActions: [],
    updatedAt: 1,
    ...overrides,
  }
}

function harness(createResult: WorktreeCreationSnapshot, actResult: WorktreeCreationSnapshot) {
  const act = vi.fn<(request: WorktreeCreationActionRequest) => Promise<WorktreeCreationSnapshot>>()
  act.mockResolvedValue(actResult)
  const storage: MobileNewSessionCreationStorage = {
    key: () => 'key',
    save: vi.fn(async () => undefined),
    load: vi.fn(async () => null),
    remove: vi.fn(async () => undefined),
  }
  const coordinator = createNewSessionCreationCoordinator({
    nextCreationId: () => 'create-1',
    now: () => 1,
    worktrees: { create: vi.fn(async () => createResult), get: vi.fn(async () => createResult), act },
    storage,
    parentCheckout: { create: vi.fn() },
    onReady: vi.fn(),
  })
  return { coordinator, act, storage }
}

function state(overrides: Partial<WorktreeCreationSnapshot>, status = overrides.status ?? 'pending') {
  return {
    creationId: 'create-1',
    status,
    intent,
    snapshot: snapshot(overrides),
  } as MobileNewSessionCreationState
}

describe('mobile new-session worktree recovery actions', () => {
  it('offers each action only when the backend lists it', () => {
    expect(newSessionCreationActions(state({ recoveryActions: ['cancel'] }))).toMatchObject({
      canCancel: true,
      canRetain: false,
      canRemove: false,
      canCheckStatus: true,
      progressLabel: 'Preparing worktree',
      correlation: 'Creation create-1, revision 1',
    })
    expect(
      newSessionCreationActions(
        state({ status: 'cleanup_required', phase: 'provisioning', recoveryActions: ['retain', 'remove'] }),
      ),
    ).toMatchObject({ canCancel: false, canRetain: true, canRemove: true, progressLabel: 'Worktree cleanup required' })
  })

  it('names the cleanup outcome and a cancellation', () => {
    const label = (overrides: Partial<WorktreeCreationSnapshot>) =>
      newSessionCreationActions(state(overrides)).progressLabel
    expect(label({ status: 'cleanup_required', cleanupDisposition: 'retained' })).toBe('Worktree retained for recovery')
    expect(label({ status: 'cleanup_required', cleanupDisposition: 'removed' })).toBe('Worktree removed')
    expect(label({ status: 'cleanup_required', cleanupDisposition: 'removal_refused' })).toBe(
      'Worktree removal was refused',
    )
    expect(label({ status: 'cancelled' })).toBe('Worktree creation cancelled')
  })

  it('hides Check status while submitting and after a definite rejection', () => {
    expect(newSessionCreationActions({ ...state({}), status: 'submitting' }).canCheckStatus).toBe(false)
    expect(newSessionCreationActions({ creationId: 'create-1', status: 'failed', intent }).canCheckStatus).toBe(false)
    expect(newSessionCreationActions({ creationId: 'create-1', status: 'ambiguous', intent }).canCheckStatus).toBe(true)
  })

  it('sends cancel with the current revision and forgets the finished creation', async () => {
    const h = harness(
      snapshot({ revision: 2, recoveryActions: ['cancel'] }),
      snapshot({ revision: 3, status: 'cancelled', recoveryActions: [] }),
    )
    await h.coordinator.begin(intent)
    await h.coordinator.act('cancel')

    expect(h.act).toHaveBeenCalledWith({
      creationId: 'create-1',
      machineId: 'machine-1',
      expectedRevision: 2,
      action: 'cancel',
    })
    expect(h.coordinator.getState().status).toBe('cancelled')
    expect(h.storage.remove).toHaveBeenCalledWith('connection-1', '/projects/switchboard')
  })

  it('keeps a retained worktree saved while removal is still offered', async () => {
    const h = harness(
      snapshot({ status: 'cleanup_required', phase: 'provisioning', recoveryActions: ['retain', 'remove'] }),
      snapshot({
        revision: 2,
        status: 'cleanup_required',
        phase: 'provisioning',
        cleanupDisposition: 'retained',
        recoveryActions: ['remove'],
      }),
    )
    await h.coordinator.begin(intent)
    await h.coordinator.act('retain')

    expect(h.act.mock.calls[0][0].action).toBe('retain')
    expect(newSessionCreationActions(h.coordinator.getState())).toMatchObject({
      canRemove: true,
      canRetain: false,
      progressLabel: 'Worktree retained for recovery',
    })
    expect(h.storage.remove).not.toHaveBeenCalled()
  })

  it('refuses an action the backend does not offer', async () => {
    const h = harness(snapshot({ recoveryActions: ['cancel'] }), snapshot())
    await h.coordinator.begin(intent)
    await expect(h.coordinator.act('remove')).rejects.toThrow('This worktree action is not available.')
    expect(h.act).not.toHaveBeenCalled()
  })

  it('shows a refused removal as failed with the backend message', async () => {
    const h = harness(
      snapshot({ status: 'cleanup_required', phase: 'provisioning', recoveryActions: ['retain', 'remove'] }),
      snapshot(),
    )
    h.act.mockRejectedValueOnce(new Error('Remote worktree removal requires the terminal device scope.'))
    await h.coordinator.begin(intent)
    await h.coordinator.act('remove')

    expect(h.coordinator.getState()).toMatchObject({
      status: 'failed',
      error: 'Remote worktree removal requires the terminal device scope.',
    })
  })
})
