/**
 * Kanban store — focused tests on the renderer-side cache behaviors that
 * back the new drag/drop + auto-promote features.
 *
 *   - `findByConversationId` indexes across all projects (the auto-promote
 *     path in ChatPanel doesn't know which project a session belongs to).
 *   - `move` is optimistic so drag-drops feel instant — the cache must
 *     reflect the new status synchronously, before the mocked IPC resolves.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore } from '../../src/renderer/stores/kanban-store'
import type { KanbanCard, KanbanCardUpdate } from '../../src/shared/kanban'

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
  // Reset the store between tests — Zustand is module-level so leaks
  // between tests would be subtle.
  useKanbanStore.setState({ byProject: {}, busy: false })

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
    // Don't await — we want to assert the cache reflects the move *before*
    // the awaited IPC has had a chance to round-trip.
    const inflight = useKanbanStore.getState().move('card_a', 'done')
    expect(useKanbanStore.getState().byProject['/p'][0].status).toBe('done')
    await inflight
    // Post-IPC the cache should still be `done` — the IPC echo doesn't
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
