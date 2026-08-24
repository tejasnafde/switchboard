/**
 * Kanban store - focused tests on the renderer-side cache behaviors that
 * back the new drag/drop + auto-promote features.
 *
 *   - `findByConversationId` indexes across all projects (the auto-promote
 *     path in ChatPanel doesn't know which project a session belongs to).
 *   - `move` is optimistic so drag-drops feel instant - the cache must
 *     reflect the new status synchronously, before the mocked IPC resolves.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore } from '../../src/renderer/stores/kanban-store'
import type { KanbanCard, KanbanCardUpdate } from '../../src/shared/kanban'
import type { WorktreeCreationProgressEvent, WorktreeCreationSnapshot } from '../../src/shared/worktree-creation'

function fakeCard(over: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'card_a',
    projectPath: '/p',
    title: 't',
    description: '',
    tags: [],
    status: 'in_progress',
    costCapUsd: null,
    costUsedUsd: null,
    runtimeMode: 'accept-edits',
    conversationId: null,
    worktreePath: null,
    worktreeBranch: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...over,
  }
}

beforeEach(() => {
  // Reset the store between tests - Zustand is module-level so leaks
  // between tests would be subtle.
  useKanbanStore.setState({ byProject: {}, busy: false, launchingCardIds: new Set() })

  // Mock the renderer IPC surface; tests don't care about return shape
  // beyond `update` echoing back the patched card so the non-optimistic
  // post-IPC patch in `update()` is a no-op when used through `move`.
  ;(globalThis as { window?: unknown }).window = {
    api: {
      kanban: {
        update: vi.fn(async (id: string, patch: KanbanCardUpdate) => {
          const list = useKanbanStore.getState().byProject['/p'] ?? []
          const hit = list.find((c) => c.id === id)
          return hit ? { ...hit, ...patch } : null
        }),
      },
    },
  }
})

describe('findByConversationId', () => {
  it('returns the card matching a conversation across any project', () => {
    useKanbanStore.setState({
      byProject: {
        '/a': [fakeCard({ id: 'a1', projectPath: '/a', conversationId: 'conv-1' })],
        '/b': [fakeCard({ id: 'b1', projectPath: '/b', conversationId: 'conv-2' })],
      },
    })
    expect(useKanbanStore.getState().findByConversationId('conv-2')?.id).toBe('b1')
  })

  it('returns undefined when no card claims the conversation', () => {
    useKanbanStore.setState({
      byProject: { '/a': [fakeCard({ conversationId: 'other' })] },
    })
    expect(useKanbanStore.getState().findByConversationId('missing')).toBeUndefined()
  })
})

describe('move (optimistic)', () => {
  it('patches the cache synchronously, before the IPC promise resolves', async () => {
    useKanbanStore.setState({
      byProject: { '/p': [fakeCard({ status: 'in_progress' })] },
    })
    // Don't await - we want to assert the cache reflects the move *before*
    // the awaited IPC has had a chance to round-trip.
    const inflight = useKanbanStore.getState().move('card_a', 'done')
    expect(useKanbanStore.getState().byProject['/p'][0].status).toBe('done')
    await inflight
    // Post-IPC the cache should still be `done` - the IPC echo doesn't
    // regress us.
    expect(useKanbanStore.getState().byProject['/p'][0].status).toBe('done')
  })

  it('does nothing when the card id is not in any cached project', async () => {
    useKanbanStore.setState({ byProject: { '/p': [fakeCard()] } })
    await useKanbanStore.getState().move('not-a-real-card', 'done')
    // Original card untouched.
    expect(useKanbanStore.getState().byProject['/p'][0].status).toBe('in_progress')
  })
})

describe('card launch guard', () => {
  // A second ▶ click while launchCardChat is in flight mints a new agent
  // session id and overwrites card.conversationId, orphaning the first
  // provider process. beginCardLaunch is the synchronous take-the-lock
  // primitive both KanbanView and CardModal share.
  it('beginCardLaunch marks the card as launching and returns true', () => {
    expect(useKanbanStore.getState().beginCardLaunch('card_a')).toBe(true)
    expect(useKanbanStore.getState().launchingCardIds.has('card_a')).toBe(true)
  })

  it('beginCardLaunch returns false while a launch is already in flight', () => {
    expect(useKanbanStore.getState().beginCardLaunch('card_a')).toBe(true)
    expect(useKanbanStore.getState().beginCardLaunch('card_a')).toBe(false)
    // Still marked launching - the losing call must not clear the flag.
    expect(useKanbanStore.getState().launchingCardIds.has('card_a')).toBe(true)
  })

  it('endCardLaunch releases the guard so a later launch can proceed', () => {
    useKanbanStore.getState().beginCardLaunch('card_a')
    useKanbanStore.getState().endCardLaunch('card_a')
    expect(useKanbanStore.getState().launchingCardIds.has('card_a')).toBe(false)
    expect(useKanbanStore.getState().beginCardLaunch('card_a')).toBe(true)
  })

  it('is per-card: launching one card does not block another', () => {
    expect(useKanbanStore.getState().beginCardLaunch('card_a')).toBe(true)
    expect(useKanbanStore.getState().beginCardLaunch('card_b')).toBe(true)
    useKanbanStore.getState().endCardLaunch('card_a')
    expect(useKanbanStore.getState().launchingCardIds.has('card_b')).toBe(true)
  })
})

describe('transactional worktree mutations', () => {
  it('keeps a failed worktree snapshot on the preserved backlog card', async () => {
    const failed = {
      creationId: 'creation-1',
      revision: 3,
      phase: 'materializing',
      status: 'failed',
      projectPath: '/p',
      baseRef: 'HEAD',
      owner: { kind: 'kanban-card', cardId: 'card_a' },
      purpose: 'kanban',
      provenance: { surface: 'desktop', machineId: 'local', requestedAt: 1 },
      warnings: [],
      error: { code: 'git', phase: 'materializing', message: 'Branch exists.', retryable: true },
      recoveryActions: ['retry'],
      updatedAt: 2,
    } satisfies WorktreeCreationSnapshot
    const create = vi.fn(async () => ({
      ...fakeCard({ status: 'backlog' }),
      worktreeCreation: failed,
    }))
    ;(globalThis as { window?: unknown }).window = { api: { kanban: { create } } }

    const result = await useKanbanStore.getState().create({
      projectPath: '/p',
      title: 't',
      withWorktree: true,
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      withWorktree: true,
      worktreeCreation: expect.objectContaining({
        cardId: expect.any(String),
        creationId: expect.any(String),
        machineId: 'local',
      }),
    }))
    expect(result?.worktreeCreation).toEqual(failed)
    expect(useKanbanStore.getState().byProject['/p'][0].worktreeCreation).toEqual(failed)
  })

  it('passes stable attach identity and caches the returned progress snapshot', async () => {
    const pending = {
      creationId: 'attach-1',
      revision: 2,
      phase: 'materializing',
      status: 'pending',
      projectPath: '/p',
      baseRef: 'HEAD',
      owner: { kind: 'kanban-card', cardId: 'card_a', expectedRevision: 0 },
      purpose: 'kanban',
      provenance: { surface: 'desktop', machineId: 'local', requestedAt: 1 },
      warnings: [],
      recoveryActions: [],
      updatedAt: 2,
    } satisfies WorktreeCreationSnapshot
    useKanbanStore.setState({ byProject: { '/p': [fakeCard({ status: 'backlog' })] } })
    const createWorktree = vi.fn(async () => ({ ...fakeCard(), worktreeCreation: pending }))
    ;(globalThis as { window?: unknown }).window = { api: { kanban: { createWorktree } } }

    const updated = await useKanbanStore.getState().attachWorktree('card_a')

    expect(createWorktree).toHaveBeenCalledWith('card_a', expect.objectContaining({
      creationId: expect.any(String),
      machineId: 'local',
    }))
    expect(updated?.worktreeCreation).toEqual(pending)
    expect(useKanbanStore.getState().byProject['/p'][0].worktreeCreation).toEqual(pending)
  })

  it('retries a failed creation with the journal revision and keeps the returned snapshot', async () => {
    const failed = {
      creationId: 'creation-1', revision: 3, phase: 'materializing', status: 'failed',
      projectPath: '/p', baseRef: 'HEAD',
      owner: { kind: 'kanban-card', cardId: 'card_a' }, purpose: 'kanban',
      provenance: { surface: 'desktop', machineId: 'local', requestedAt: 1 },
      warnings: [], recoveryActions: ['retry'], updatedAt: 2,
    } satisfies WorktreeCreationSnapshot
    const ready = {
      ...failed,
      revision: 5,
      phase: 'ready',
      status: 'ready',
      worktreePath: '/p/.switchboard/worktrees/card-a',
      branch: 'kanban/card-a',
      recoveryActions: [],
    } satisfies WorktreeCreationSnapshot
    useKanbanStore.setState({
      byProject: { '/p': [fakeCard({ status: 'backlog', worktreeCreation: failed })] },
    })
    const act = vi.fn(async () => ready)
    ;(globalThis as { window?: unknown }).window = { api: { worktreeCreation: { act } } }

    await useKanbanStore.getState().retryWorktree('card_a')

    expect(act).toHaveBeenCalledWith({
      creationId: 'creation-1', machineId: 'local', expectedRevision: 3, action: 'retry',
    })
    expect(useKanbanStore.getState().byProject['/p'][0]).toMatchObject({
      worktreePath: '/p/.switchboard/worktrees/card-a',
      worktreeBranch: 'kanban/card-a',
      worktreeCreation: ready,
    })
  })

  it('reconciles journal progress into the cached card by creation id', async () => {
    const pending = {
      creationId: 'creation-1', revision: 2, phase: 'materializing', status: 'pending',
      projectPath: '/p', baseRef: 'HEAD',
      owner: { kind: 'kanban-card', cardId: 'card_a' }, purpose: 'kanban',
      provenance: { surface: 'desktop', machineId: 'local', requestedAt: 1 },
      warnings: [], recoveryActions: [], updatedAt: 2,
    } satisfies WorktreeCreationSnapshot
    const failed = {
      ...pending,
      revision: 3,
      status: 'failed',
      error: { code: 'git', phase: 'materializing', message: 'Branch exists.', retryable: true },
      recoveryActions: ['retry'],
      updatedAt: 3,
    } satisfies WorktreeCreationSnapshot
    useKanbanStore.setState({
      byProject: { '/p': [fakeCard({ worktreeCreation: pending })] },
    })
    const get = vi.fn(async () => failed)
    ;(globalThis as { window?: unknown }).window = { api: { worktreeCreation: { get } } }
    const event = {
      creationId: 'creation-1',
      revision: 3,
      phase: 'materializing',
      status: 'failed',
      timestamp: 3,
      recoveryActions: ['retry'],
    } satisfies WorktreeCreationProgressEvent

    await useKanbanStore.getState().reconcileWorktreeProgress(event)

    expect(get).toHaveBeenCalledWith({ creationId: 'creation-1', machineId: 'local' })
    expect(useKanbanStore.getState().byProject['/p'][0].worktreeCreation).toEqual(failed)
  })
})
