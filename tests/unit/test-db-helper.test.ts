/** The shared test database: in memory, migrated, and fresh on every call. */
import { describe, expect, it } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import { getDb, getSetting, setSetting } from '../../src/main/db/database'

describe('createMigratedDb', () => {
  it('backs getDb with a fresh migrated in-memory database', () => {
    const first = createMigratedDb()
    expect(first.name).toBe(':memory:')
    expect(getDb()).toBe(first)
    expect(first.prepare("SELECT id FROM provider_instances WHERE id = 'codex-default'").get()).toBeDefined()
    setSetting('k', 'v')

    const second = createMigratedDb()
    expect(first.open).toBe(false)
    expect(getDb()).toBe(second)
    expect(getSetting('k')).toBeNull()
  })
})
