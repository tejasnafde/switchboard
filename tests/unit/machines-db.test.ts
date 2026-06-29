/**
 * Machines CRUD over a fake getDb (better-sqlite3's prebuilt binary targets
 * Electron's ABI and won't load under vitest). Pins sort_order assignment,
 * reorder, update-merge, and delete.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface DbRow {
  id: string
  name: string
  ssh_alias: string | null
  ssh_host: string
  ssh_user: string | null
  ssh_port: number
  sort_order: number
  created_at: number
  updated_at: number
}

const store = new Map<string, DbRow>()

function prepare(sql: string) {
  if (sql.includes('ORDER BY sort_order')) {
    return {
      all: () =>
        [...store.values()].sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at),
    }
  }
  if (sql.includes('MAX(sort_order)')) {
    return { get: () => ({ m: store.size ? Math.max(...[...store.values()].map((r) => r.sort_order)) : -1 }) }
  }
  if (sql.startsWith('INSERT INTO machines')) {
    return {
      run: (p: Record<string, unknown>) => {
        store.set(p.id as string, {
          id: p.id as string,
          name: p.name as string,
          ssh_alias: (p.sshAlias ?? null) as string | null,
          ssh_host: p.sshHost as string,
          ssh_user: (p.sshUser ?? null) as string | null,
          ssh_port: p.sshPort as number,
          sort_order: p.sortOrder as number,
          created_at: p.createdAt as number,
          updated_at: p.updatedAt as number,
        })
      },
    }
  }
  if (sql.includes('SELECT * FROM machines WHERE id')) {
    return { get: (id: string) => store.get(id) }
  }
  if (sql.startsWith('UPDATE machines SET name=')) {
    return {
      run: (p: Record<string, unknown>) => {
        const r = store.get(p.id as string)
        if (!r) return
        Object.assign(r, {
          name: p.name,
          ssh_alias: p.sshAlias,
          ssh_host: p.sshHost,
          ssh_user: p.sshUser,
          ssh_port: p.sshPort,
          updated_at: p.updatedAt,
        })
      },
    }
  }
  if (sql.includes('SET sort_order = ?')) {
    return {
      run: (order: number, now: number, id: string) => {
        const r = store.get(id)
        if (r) {
          r.sort_order = order
          r.updated_at = now
        }
      },
    }
  }
  if (sql.startsWith('DELETE FROM machines')) {
    return { run: (id: string) => store.delete(id) }
  }
  throw new Error(`unexpected SQL: ${sql}`)
}

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare, transaction: (fn: (a: unknown) => void) => (a: unknown) => fn(a) }),
}))

import { listMachines, createMachine, updateMachine, deleteMachine, reorderMachines } from '../../src/main/db/machines'

beforeEach(() => store.clear())

describe('machines CRUD', () => {
  it('createMachine assigns incrementing sort_order and round-trips fields', () => {
    const a = createMachine({ name: 'prod-vm', sshHost: '10.0.4.12', sshUser: 'ubuntu', sshPort: 2222 }, 1000)
    const b = createMachine({ name: 'gpu-box', sshHost: '192.168.1.50' }, 1001)
    expect(a.sortOrder).toBe(0)
    expect(b.sortOrder).toBe(1)
    expect(a).toMatchObject({ name: 'prod-vm', sshHost: '10.0.4.12', sshUser: 'ubuntu', sshPort: 2222 })
    expect(b).toMatchObject({ sshUser: null, sshPort: 22 })
  })

  it('listMachines returns rows ordered by sort_order', () => {
    createMachine({ name: 'a', sshHost: 'h1' }, 1)
    createMachine({ name: 'b', sshHost: 'h2' }, 2)
    expect(listMachines().map((m) => m.name)).toEqual(['a', 'b'])
  })

  it('updateMachine merges only provided fields', () => {
    const m = createMachine({ name: 'old', sshHost: 'h', sshUser: 'u' }, 1)
    const updated = updateMachine(m.id, { name: 'new' }, 2)
    expect(updated).toMatchObject({ name: 'new', sshHost: 'h', sshUser: 'u' })
    expect(updated!.updatedAt).toBe(2)
  })

  it('updateMachine returns null for a missing id', () => {
    expect(updateMachine('nope', { name: 'x' }, 1)).toBeNull()
  })

  it('reorderMachines rewrites sort_order to match the given order', () => {
    const a = createMachine({ name: 'a', sshHost: 'h1' }, 1)
    const b = createMachine({ name: 'b', sshHost: 'h2' }, 2)
    const c = createMachine({ name: 'c', sshHost: 'h3' }, 3)
    reorderMachines([c.id, a.id, b.id], 9)
    expect(listMachines().map((m) => m.name)).toEqual(['c', 'a', 'b'])
  })

  it('deleteMachine removes the row', () => {
    const m = createMachine({ name: 'gone', sshHost: 'h' }, 1)
    deleteMachine(m.id)
    expect(listMachines()).toEqual([])
  })
})
