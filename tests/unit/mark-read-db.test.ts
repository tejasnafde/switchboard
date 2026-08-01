/**
 * Shared read state persistence, over a fake better-sqlite3 (the prebuilt
 * binary targets Electron's ABI and won't load under vitest). Same approach as
 * projects-db.test.ts: record every prepared statement so we can assert the SQL
 * and its bind order.
 *
 * Two things are pinned here. The write must NOT touch `updated_at` - that
 * drives sidebar ordering, and reading a chat must not reorder the list. And it
 * must report a missed row, because a session scanned off disk has none and the
 * caller has to know it only broadcast.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const runCalls: Array<{ sql: string; args: unknown[] }> = []
const getCalls: Array<{ sql: string; args: unknown[] }> = []

/** Rows affected by the next run(); tests set this per case. */
let nextChanges = 1
/** Row returned by the next get(); tests set this per case. */
let nextRow: unknown = undefined

vi.mock('better-sqlite3', () => {
  class FakeDb {
    pragma() {}
    exec() {}
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => {
          runCalls.push({ sql, args })
          return { changes: nextChanges }
        },
        get: (...args: unknown[]) => {
          getCalls.push({ sql, args })
          return nextRow
        },
        all: () => [],
      }
    }
  }
  return { default: FakeDb }
})

const { setConversationLastRead, getConversationLastRead } = await import('../../src/main/db/database')

// One migrate()-full of statements fires on first getDb(); ignore those.
const readWrites = () => runCalls.filter((c) => /last_read_at/.test(c.sql) && /^UPDATE/.test(c.sql.trim()))
const readQueries = () => getCalls.filter((c) => /last_read_at/.test(c.sql))

beforeEach(() => {
  runCalls.length = 0
  getCalls.length = 0
  nextChanges = 1
  nextRow = undefined
})

describe('setConversationLastRead', () => {
  it('binds (at, id) in that order', () => {
    setConversationLastRead('conv-1', 1700)
    const writes = readWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0].args).toEqual([1700, 'conv-1'])
  })

  it('leaves updated_at alone, so reading a chat does not reorder the sidebar', () => {
    setConversationLastRead('conv-1', 1700)
    expect(readWrites()[0].sql).not.toMatch(/updated_at/)
  })

  it('reports true when a row was stamped', () => {
    nextChanges = 1
    expect(setConversationLastRead('conv-1', 1700)).toBe(true)
  })

  it('reports false for a conversation with no row, rather than throwing', () => {
    nextChanges = 0
    expect(setConversationLastRead('scanned-only', 1700)).toBe(false)
  })
})

describe('getConversationLastRead', () => {
  it('returns the stored timestamp', () => {
    nextRow = { last_read_at: 1700 }
    expect(getConversationLastRead('conv-1')).toBe(1700)
    expect(readQueries()[0].args).toEqual(['conv-1'])
  })

  it('returns null for a never-read conversation', () => {
    nextRow = { last_read_at: null }
    expect(getConversationLastRead('conv-1')).toBeNull()
  })

  it('returns null when the conversation does not exist', () => {
    nextRow = undefined
    expect(getConversationLastRead('nope')).toBeNull()
  })
})
