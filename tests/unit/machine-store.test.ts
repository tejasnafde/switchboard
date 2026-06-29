/**
 * machine-store: the logic-bearing bits (optimistic reorder, collapse toggle,
 * mutate-then-rehydrate). window.api.machines is faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMachineStore } from '../../src/renderer/stores/machine-store'
import type { Machine } from '@shared/machines'

const mk = (id: string, sortOrder: number): Machine => ({
  id, name: id, sshAlias: null, sshHost: `${id}.host`, sshUser: null,
  sshPort: 22, sortOrder, createdAt: sortOrder, updatedAt: sortOrder,
})

let stored: Machine[] = []
const create = vi.fn(async (input: { name: string }) => {
  const m = mk(input.name, stored.length)
  stored.push(m)
  return m
})
const del = vi.fn(async (id: string) => {
  stored = stored.filter((m) => m.id !== id)
  return { ok: true as const }
})
const reorder = vi.fn(async () => ({ ok: true as const }))

beforeEach(() => {
  stored = [mk('a', 0), mk('b', 1), mk('c', 2)]
  ;(globalThis as { window?: unknown }).window = {
    api: {
      machines: {
        list: vi.fn(async () => stored),
        create,
        update: vi.fn(async () => null),
        delete: del,
        reorder,
        listSshHosts: vi.fn(async () => []),
      },
    },
  }
  useMachineStore.setState({ remotes: [], connections: {}, activeMachineId: 'local', collapsed: new Set(), sshHosts: [] })
  vi.clearAllMocks()
})

describe('machine-store', () => {
  it('hydrate pulls the machine list from main', async () => {
    await useMachineStore.getState().hydrate()
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('reorder applies the new order optimistically and persists', async () => {
    await useMachineStore.getState().hydrate()
    await useMachineStore.getState().reorder(['c', 'a', 'b'])
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['c', 'a', 'b'])
    expect(reorder).toHaveBeenCalledWith(['c', 'a', 'b'])
  })

  it('add creates then re-hydrates', async () => {
    await useMachineStore.getState().add({ name: 'd', sshHost: 'd.host' })
    expect(create).toHaveBeenCalled()
    expect(useMachineStore.getState().remotes.some((m) => m.id === 'd')).toBe(true)
  })

  it('remove deletes then re-hydrates', async () => {
    await useMachineStore.getState().hydrate()
    await useMachineStore.getState().remove('b')
    expect(del).toHaveBeenCalledWith('b')
    expect(useMachineStore.getState().remotes.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('toggleCollapsed flips membership', () => {
    const { toggleCollapsed } = useMachineStore.getState()
    toggleCollapsed('a')
    expect(useMachineStore.getState().collapsed.has('a')).toBe(true)
    toggleCollapsed('a')
    expect(useMachineStore.getState().collapsed.has('a')).toBe(false)
  })
})
