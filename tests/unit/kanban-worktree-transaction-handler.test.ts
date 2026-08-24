import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { BackendHost } from '../../src/main/backend/host'
import { KanbanChannels } from '../../src/shared/ipc-channels'
import type { KanbanCard } from '../../src/shared/kanban'
import type { WorktreeCreationRequest, WorktreeCreationSnapshot } from '../../src/shared/worktree-creation'

const state = vi.hoisted(() => ({
  card: null as KanbanCard | null,
  createPlainCard: vi.fn(),
  setKanbanWorktree: vi.fn(),
  legacyCreateWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  listWorktrees: vi.fn(async () => [] as Array<{ path: string }>),
  inUsePaths: new Set<string>(),
  creationKey: null as { machineId: string; creationId: string } | null,
}))

vi.mock('../../src/main/db/database', () => ({
  createKanbanCard: state.createPlainCard,
  listKanbanCards: vi.fn(() => state.card ? [state.card] : []),
  updateKanbanCard: vi.fn(),
  deleteKanbanCard: vi.fn(),
  setKanbanWorktree: state.setKanbanWorktree,
  getKanbanCard: vi.fn(() => state.card),
  getKanbanWorktreeCreationKey: vi.fn(() => state.creationKey),
  listInUseWorktreePaths: vi.fn(() => state.inUsePaths),
}))

vi.mock('../../src/main/worktree', () => ({
  createWorktree: state.legacyCreateWorktree,
  removeWorktree: state.removeWorktree,
  listWorktrees: state.listWorktrees,
  findStaleWorktrees: vi.fn(async () => []),
  rmWorktreeDir: vi.fn(),
  worktreeRootFor: vi.fn(() => '/repo/.switchboard/worktrees'),
}))

const { registerKanbanHandlers } = await import('../../src/main/ipc/kanban')

class FakeHost implements BackendHost {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }
  on(): void {}
  emit(): void {}
}

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'card-1',
    projectPath: '/repo',
    title: 'Atomic card',
    description: 'Preserve this draft.',
    tags: ['backend'],
    status: 'backlog',
    costCapUsd: 12,
    costUsedUsd: null,
    runtimeMode: 'plan',
    conversationId: null,
    worktreePath: null,
    worktreeBranch: null,
    createdAt: 100,
    updatedAt: 700,
    completedAt: null,
    ...overrides,
  }
}

function snapshot(
  request: WorktreeCreationRequest,
  overrides: Partial<WorktreeCreationSnapshot> = {},
): WorktreeCreationSnapshot {
  return {
    creationId: request.creationId,
    revision: 3,
    phase: 'materializing',
    status: 'failed',
    projectPath: request.repository.projectPath,
    worktreePath: '/repo/.switchboard/worktrees/card-1',
    branch: 'kanban/atomic-card',
    baseRef: request.checkout.baseRef,
    owner: request.owner,
    purpose: request.purpose,
    provenance: request.provenance,
    warnings: [],
    error: {
      code: 'branch_exists',
      phase: 'materializing',
      message: 'The requested branch already exists.',
      retryable: true,
    },
    recoveryActions: ['retry'],
    updatedAt: 900,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.card = null
  state.creationKey = null
  state.inUsePaths = new Set()
  state.listWorktrees.mockResolvedValue([])
})

describe('Kanban worktree transaction compatibility handlers', () => {
  it('fails explicitly before creating a card when the transaction runtime is unavailable', async () => {
    const host = new FakeHost()
    registerKanbanHandlers(host, { createCardId: () => 'card-1' })

    await expect(host.handlers.get(KanbanChannels.CREATE)!({
      projectPath: '/repo',
      title: 'Atomic card',
      withWorktree: true,
    })).rejects.toThrow('transaction is unavailable')

    expect(state.createPlainCard).not.toHaveBeenCalled()
    expect(state.legacyCreateWorktree).not.toHaveBeenCalled()
    expect(state.setKanbanWorktree).not.toHaveBeenCalled()
  })

  it('returns a deliberately preserved backlog card plus failed snapshot without a plain-card first write', async () => {
    const host = new FakeHost()
    let submitted!: WorktreeCreationRequest
    registerKanbanHandlers(host, {
      createWorktreeTransaction: async (request) => {
        submitted = request
        state.card = card({ id: request.owner.kind === 'kanban-card' ? request.owner.cardId : 'wrong' })
        return snapshot(request)
      },
      createCardId: () => 'card-1',
      createCreationId: () => 'creation-1',
      now: () => 800,
    })

    const create = host.handlers.get(KanbanChannels.CREATE)!
    const result = await create({
      projectPath: '/repo',
      title: 'Atomic card',
      description: 'Preserve this draft.',
      tags: ['backend'],
      costCapUsd: 12,
      runtimeMode: 'plan',
      withWorktree: true,
      worktreeCreation: {
        machineId: 'machine-1',
        baseRef: 'main',
        setupPolicy: 'skip',
      },
    }) as KanbanCard & { worktreeCreation: WorktreeCreationSnapshot }

    expect(state.createPlainCard).not.toHaveBeenCalled()
    expect(state.legacyCreateWorktree).not.toHaveBeenCalled()
    expect(submitted).toMatchObject({
      creationId: 'creation-1',
      repository: { projectPath: '/repo', machineId: 'machine-1' },
      checkout: { baseRef: 'main', branch: { namespace: 'kanban', seed: 'Atomic card' } },
      owner: {
        kind: 'kanban-card',
        cardId: 'card-1',
        create: {
          title: 'Atomic card',
          description: 'Preserve this draft.',
          tags: ['backend'],
          status: 'backlog',
          runtimeMode: 'plan',
          costCapUsd: 12,
        },
      },
    })
    expect(result).toMatchObject({
      id: 'card-1',
      status: 'backlog',
      worktreePath: null,
      worktreeCreation: {
        status: 'failed',
        error: { message: 'The requested branch already exists.' },
        recoveryActions: ['retry'],
      },
    })
  })

  it('reattaches a failed null-worktree reservation when the board reloads', async () => {
    const host = new FakeHost()
    state.card = card()
    state.creationKey = { machineId: 'machine-1', creationId: 'creation-1' }
    const failed = snapshot({
      schemaVersion: 1,
      creationId: 'creation-1',
      repository: { projectPath: '/repo', machineId: 'machine-1' },
      checkout: { baseRef: 'main', branch: { namespace: 'kanban', seed: 'Atomic card' } },
      owner: { kind: 'kanban-card', cardId: 'card-1' },
      purpose: 'kanban',
      setup: { policy: 'skip' },
      provenance: { surface: 'desktop', machineId: 'machine-1', requestedAt: 1 },
    })
    const getWorktreeCreation = vi.fn(async () => failed)
    registerKanbanHandlers(host, { getWorktreeCreation })

    const result = await host.handlers.get(KanbanChannels.LIST)!('/repo') as Array<
      KanbanCard & { worktreeCreation?: WorktreeCreationSnapshot }
    >

    expect(result[0]).toMatchObject({
      id: 'card-1',
      worktreePath: null,
      worktreeCreation: { creationId: 'creation-1', status: 'failed' },
    })
    expect(getWorktreeCreation).toHaveBeenCalledWith(state.creationKey)
  })

  it('attaches an existing card with its fetched updatedAt as the expected revision', async () => {
    const host = new FakeHost()
    state.card = card()
    let submitted!: WorktreeCreationRequest
    registerKanbanHandlers(host, {
      createWorktreeTransaction: async (request) => {
        submitted = request
        state.card = card({
          worktreePath: '/repo/.switchboard/worktrees/card-1',
          worktreeBranch: 'kanban/atomic-card',
        })
        return snapshot(request, { phase: 'ready', status: 'ready', error: undefined, recoveryActions: [] })
      },
      createCardId: () => 'server-card-unused',
      createCreationId: () => 'server-generated-unused',
      now: () => 800,
    })

    const attach = host.handlers.get(KanbanChannels.CREATE_WORKTREE)!
    const result = await attach('card-1', {
      creationId: 'creation-attach-1',
      machineId: 'machine-1',
      requestedAt: 750,
    }) as KanbanCard & { worktreeCreation: WorktreeCreationSnapshot }

    expect(submitted).toMatchObject({
      creationId: 'creation-attach-1',
      owner: { kind: 'kanban-card', cardId: 'card-1', expectedRevision: 700 },
      provenance: { requestedAt: 750 },
    })
    expect(result).toMatchObject({
      worktreePath: '/repo/.switchboard/worktrees/card-1',
      worktreeCreation: { status: 'ready' },
    })
    expect(state.legacyCreateWorktree).not.toHaveBeenCalled()
  })

  it('stores initial-agent launch intent without starting a provider in the renderer path', async () => {
    const host = new FakeHost()
    let submitted!: WorktreeCreationRequest
    registerKanbanHandlers(host, {
      createWorktreeTransaction: async (request) => {
        submitted = request
        state.card = card()
        return snapshot(request, { phase: 'provisioning', status: 'pending', error: undefined, recoveryActions: [] })
      },
      createCardId: () => 'card-1',
      createCreationId: () => 'creation-1',
      now: () => 800,
    })

    await host.handlers.get(KanbanChannels.CREATE)!({
      projectPath: '/repo',
      title: 'Atomic card',
      withWorktree: true,
      worktreeCreation: {
        machineId: 'machine-1',
        initialAgent: {
          provider: 'claude-code',
          runtimeMode: 'plan',
          prompt: 'Implement the card.',
        },
      },
    })

    expect(submitted.launch).toEqual({
      initialAgent: {
        provider: 'claude-code',
        runtimeMode: 'plan',
        prompt: 'Implement the card.',
      },
    })
    expect(submitted.owner).toMatchObject({
      kind: 'kanban-card',
      create: { status: 'backlog' },
    })
  })

  it('preserves an explicitly supplied status when a new card has no initial agent', async () => {
    const host = new FakeHost()
    let submitted!: WorktreeCreationRequest
    registerKanbanHandlers(host, {
      createWorktreeTransaction: async (request) => {
        submitted = request
        state.card = card({ status: 'needs_input' })
        return snapshot(request)
      },
      createCardId: () => 'card-1',
      createCreationId: () => 'creation-1',
      now: () => 800,
    })

    await host.handlers.get(KanbanChannels.CREATE)!({
      projectPath: '/repo',
      title: 'Review card',
      status: 'needs_input',
      withWorktree: true,
      worktreeCreation: { machineId: 'machine-1' },
    })

    expect(submitted.owner).toMatchObject({
      kind: 'kanban-card',
      create: { status: 'needs_input' },
    })
  })

  it('removes a managed card worktree through its canonical creation identity', async () => {
    const host = new FakeHost()
    state.card = card({
      worktreePath: '/repo/.switchboard/worktrees/card-1',
      worktreeBranch: 'kanban/card-1',
    })
    state.creationKey = { machineId: 'machine-1', creationId: 'creation-1' }
    const getWorktreeCreation = vi.fn(async () => snapshot({
      ...({} as WorktreeCreationRequest),
      creationId: 'creation-1',
      repository: { projectPath: '/repo', machineId: 'machine-1' },
      checkout: { baseRef: 'main', branch: { namespace: 'kanban', seed: 'card-1' } },
      owner: { kind: 'kanban-card', cardId: 'card-1', expectedRevision: 700 },
      purpose: 'kanban',
      setup: { policy: 'skip' },
      provenance: { surface: 'desktop', machineId: 'machine-1', requestedAt: 1 },
      schemaVersion: 1,
    }, { revision: 9, status: 'ready', phase: 'ready' }))
    const actOnWorktreeCreation = vi.fn(async () => {
      state.card = card()
      return { cleanupDisposition: 'removed' } as WorktreeCreationSnapshot
    })
    registerKanbanHandlers(host, { getWorktreeCreation, actOnWorktreeCreation })

    await host.handlers.get(KanbanChannels.REMOVE_WORKTREE)!('card-1', { force: true })

    expect(actOnWorktreeCreation).toHaveBeenCalledWith({
      machineId: 'machine-1',
      creationId: 'creation-1',
      expectedRevision: 9,
      action: 'remove',
    })
    expect(state.removeWorktree).not.toHaveBeenCalled()
  })

  it('refuses to remove a legacy card worktree by path when canonical identity is unavailable', async () => {
    const host = new FakeHost()
    state.card = card({
      worktreePath: '/repo/.switchboard/worktrees/card-1',
      worktreeBranch: 'kanban/card-1',
    })
    state.creationKey = null
    registerKanbanHandlers(host)

    await expect(host.handlers.get(KanbanChannels.REMOVE_WORKTREE)!('card-1', { force: true }))
      .rejects.toThrow(/canonical worktree identity/i)

    expect(state.removeWorktree).not.toHaveBeenCalled()
    expect(state.setKanbanWorktree).not.toHaveBeenCalled()
  })

  it('refuses stale path deletion unless Git registers the exact unowned path', async () => {
    const host = new FakeHost()
    const registered = resolve('/repo/.switchboard/worktrees/card-1')
    state.listWorktrees.mockResolvedValue([{ path: registered }])
    state.inUsePaths = new Set([registered])
    registerKanbanHandlers(host)
    const removeStale = host.handlers.get(KanbanChannels.REMOVE_STALE_WORKTREE)!

    await expect(removeStale('/repo', '/repo/.switchboard/worktrees-evil', { force: true }))
      .rejects.toThrow(/not registered/i)
    await expect(removeStale('/repo', registered, { force: true }))
      .rejects.toThrow(/owned by an active/i)
    expect(state.removeWorktree).not.toHaveBeenCalled()

    state.inUsePaths = new Set()
    await removeStale('/repo', registered, { force: true })
    expect(state.removeWorktree).toHaveBeenCalledWith('/repo', registered, { force: true })
  })
})
