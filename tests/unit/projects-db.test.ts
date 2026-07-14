/**
 * Projects rename/remove SQL over a fake better-sqlite3 (the prebuilt binary
 * targets Electron's ABI and won't load under vitest). The fake records every
 * prepared statement's run() args and returns empty/undefined for all reads, so
 * migrate() no-ops cleanly and we can assert the SQL + bind order our functions
 * emit. This pins renameProject's (name, path) order - the one flip-able bug in
 * the pair. The FK cascade that drops a removed project's conversations + kanban
 * cards is schema-level (ON DELETE CASCADE), verified by the migration, not TS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const runCalls: Array<{ sql: string; args: unknown[] }> = []

vi.mock('better-sqlite3', () => {
  class FakeDb {
    pragma() {}
    exec() {}
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => { runCalls.push({ sql, args }); return { changes: 1 } },
        get: () => undefined,
        all: () => [],
      }
    }
  }
  return { default: FakeDb }
})

const { renameProject, removeProject } = await import('../../src/main/db/database')

// One migrate()-full of statements fires on first getDb(); ignore those.
const projectWrites = () => runCalls.filter((c) => /\b(UPDATE|DELETE FROM) projects\b/.test(c.sql))

beforeEach(() => { runCalls.length = 0 })

describe('projects rename/remove SQL', () => {
  it('renameProject binds (name, path) in that order', () => {
    renameProject('/repo/a', 'Alpha')
    const write = projectWrites()
    expect(write).toHaveLength(1)
    expect(write[0].sql).toMatch(/UPDATE projects SET name = \? WHERE path = \?/)
    expect(write[0].args).toEqual(['Alpha', '/repo/a'])
  })

  it('removeProject deletes by path', () => {
    removeProject('/repo/a')
    const write = projectWrites()
    expect(write).toHaveLength(1)
    expect(write[0].sql).toMatch(/DELETE FROM projects WHERE path = \?/)
    expect(write[0].args).toEqual(['/repo/a'])
  })
})
