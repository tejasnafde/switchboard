import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  attempts: 0,
  firstErrorCode: 'SQLITE_ERROR',
  renames: [] as Array<[string, string]>,
}))

vi.mock('better-sqlite3', () => ({
  default: class FakeDatabase {
    private readonly attempt: number

    constructor() {
      this.attempt = ++state.attempts
    }

    pragma() {}

    exec() {
      if (this.attempt === 1) {
        const error = new Error('migration exploded') as Error & { code: string }
        error.code = state.firstErrorCode
        throw error
      }
    }

    prepare() {
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
      }
    }

    transaction(fn: () => void) { return fn }
    close() {}
  },
}))

vi.mock('../../src/main/runtime', () => ({
  userDataDir: () => '/tmp/switchboard-db-recovery-test',
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    existsSync: () => true,
    mkdirSync: () => undefined,
    renameSync: (from: string, to: string) => { state.renames.push([from, to]) },
  }
})

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}))

beforeEach(() => {
  state.attempts = 0
  state.firstErrorCode = 'SQLITE_ERROR'
  state.renames = []
  vi.resetModules()
})

describe('database reset safety', () => {
  it('surfaces a migration error without moving the database', async () => {
    const { getDb } = await import('../../src/main/db/database')

    expect(() => getDb()).toThrow('migration exploded')
    expect(state.renames).toEqual([])
  })

  it('moves aside a genuinely corrupt database before opening a fresh one', async () => {
    state.firstErrorCode = 'SQLITE_CORRUPT'
    const { getDb } = await import('../../src/main/db/database')

    expect(() => getDb()).not.toThrow()
    expect(state.renames.map(([from]) => from)).toEqual([
      join('/tmp/switchboard-db-recovery-test', 'data', 'switchboard.db'),
      join('/tmp/switchboard-db-recovery-test', 'data', 'switchboard.db-wal'),
      join('/tmp/switchboard-db-recovery-test', 'data', 'switchboard.db-shm'),
    ])
  })
})

describe('sidebar-role migration SQL', () => {
  const source = readFileSync(new URL('../../src/main/db/database.ts', import.meta.url), 'utf8')

  it('matches the agent_ prefix without an escape clause', () => {
    expect(source).toContain("WHEN id GLOB 'agent_*' THEN 'managed'")
    expect(source).not.toMatch(/WHEN id LIKE 'agent.*ESCAPE/)
  })
})
