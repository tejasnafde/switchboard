/**
 * Every column the main process writes on `conversations` must be a column
 * `migrate()` actually creates. A fork INSERT once named `launch_config_name`,
 * which lives on `session_layouts`, and every test passed because the fixtures
 * hand-rolled a table that had it ("table conversations has no column named
 * launch_config_name", reported from a release build).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createMigratedDb } from './helpers/test-db'
import { closeDb } from '../../src/main/db/database'

afterEach(() => {
  closeDb()
})

const MAIN = join(__dirname, '../../src/main')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

/**
 * Column names every `INSERT INTO conversations (...)` and `UPDATE
 * conversations SET ...` in the main process writes. A column list built at
 * runtime, inside an interpolated SQL constant, is not seen here.
 */
function writtenColumns(): Array<{ file: string; column: string }> {
  const found: Array<{ file: string; column: string }> = []
  for (const file of sourceFiles(MAIN)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/INSERT (?:OR \w+ )?INTO conversations\s*\(([^)]*)\)/g)) {
      for (const raw of match[1].split(',')) {
        const column = raw.trim()
        if (column) found.push({ file, column })
      }
    }
    for (const match of text.matchAll(/UPDATE conversations\s+SET\s+([\s\S]*?)\bWHERE\b/g)) {
      for (const assignment of match[1].matchAll(/(\w+)\s*=/g)) {
        found.push({ file, column: assignment[1] })
      }
    }
  }
  return found
}

describe('conversations writes', () => {
  it('only name columns the migrated schema has', () => {
    const db = createMigratedDb()
    const columns = new Set(
      (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    const writes = writtenColumns()
    expect(writes.length).toBeGreaterThan(10)
    expect(writes.filter((entry) => !columns.has(entry.column))).toEqual([])
  })
})
