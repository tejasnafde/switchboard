/** History window reads use a second, read-only connection to the same database file. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, getReadDb, messageWindowRows, saveMessage } from '../../src/main/db/database'

const previousDataDir = process.env.SWITCHBOARD_DATA_DIR
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sb-db-read-'))
  process.env.SWITCHBOARD_DATA_DIR = root
  const db = getDb()
  db.exec("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')")
  db.exec("INSERT INTO conversations (id, project_path) VALUES ('c1', '/repo')")
})

afterEach(() => {
  // Windows cannot unlink an open database file.
  closeDb()
  if (previousDataDir === undefined) delete process.env.SWITCHBOARD_DATA_DIR
  else process.env.SWITCHBOARD_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

describe('getReadDb', () => {
  it('opens a separate read-only, query-only connection on the same file', () => {
    const main = getDb()
    const reader = getReadDb()
    expect(reader).not.toBe(main)
    expect(reader.name).toBe(main.name)
    expect(reader.readonly).toBe(true)
    expect(reader.pragma('query_only', { simple: true })).toBe(1)
    expect(main.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(getReadDb()).toBe(reader)
  })

  it('refuses a write', () => {
    expect(() => getReadDb().exec("INSERT INTO settings (key, value) VALUES ('k', 'v')")).toThrow()
  })

  it('serves the history window reads, and sees writes committed on the main connection', () => {
    const prepare = vi.spyOn(getReadDb(), 'prepare')
    const rows = messageWindowRows(['c1'])
    expect(rows.count()).toBe(0)
    expect(prepare).toHaveBeenCalled()

    saveMessage('m1', 'c1', 'user', 'hello')
    expect(rows.count()).toBe(1)
    expect(rows.read(-Infinity, Infinity, []).map((message) => message.content)).toEqual(['hello'])
  })

  it('closes with the main connection and opens again after it', () => {
    const reader = getReadDb()
    closeDb()
    expect(reader.open).toBe(false)
    const next = getReadDb()
    expect(next.open).toBe(true)
    expect(next.readonly).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'falls back to the main connection when the read connection cannot open, until the next open',
    () => {
      const main = getDb()
      chmodSync(main.name, 0o000)
      try {
        expect(getReadDb()).toBe(main)
      } finally {
        chmodSync(main.name, 0o644)
      }
      expect(getReadDb()).toBe(main)
      closeDb()
      expect(getReadDb().readonly).toBe(true)
    },
  )

  it('falls back to the main connection when the database is not in WAL mode', () => {
    const main = getDb()
    main.pragma('journal_mode = DELETE')
    expect(getReadDb()).toBe(main)
  })
})
