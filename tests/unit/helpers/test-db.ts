/**
 * A real SQLite database with the app's own schema, for tests that want the
 * production SQL instead of a hand-rolled fake. Import it before anything
 * that loads the db modules:
 *
 *   import { createMigratedDb } from './helpers/test-db'
 *   beforeEach(() => { createMigratedDb() })
 *
 * Every connection the app opens in a file that imports this helper is
 * `:memory:`, so `getDb()` runs its real open path (pragmas, `migrate()`)
 * and never touches a file. Each call closes the previous connection and
 * returns a fresh, empty, migrated one, which every `db/*` module then uses.
 */
import { vi } from 'vitest'
import type Database from 'better-sqlite3'
import { closeDb, getDb } from '../../../src/main/db/database'

vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof Database }>()).default
  class InMemory extends Real {
    constructor(_path?: string | Buffer, options?: Database.Options) {
      super(':memory:', options)
    }
  }
  return { default: InMemory }
})

export function createMigratedDb(): Database.Database {
  closeDb()
  return getDb()
}
