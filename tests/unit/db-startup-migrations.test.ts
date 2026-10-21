/** Every start runs no full-table scan; the one-time slow steps can wait for the window. */
import { createMigratedDb } from './helpers/test-db'
import { describe, expect, it } from 'vitest'
import {
  closeDb,
  deferSlowMigrationsUntilWindow,
  getDisplayBodyEnrichments,
  migrate,
  runSlowMigrations,
} from '../../src/main/db/database'

const indexes = (db: ReturnType<typeof createMigratedDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  )

describe('startup migrations', () => {
  it('skips the FTS row counts once the backfill check has passed', () => {
    const db = createMigratedDb()
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      seen.push(sql)
      return prepare(sql)
    }) as typeof db.prepare
    migrate(db)
    expect(seen.filter((sql) => /count\(\*\)/.test(sql))).toEqual([])
    expect(indexes(db)).toContain('idx_turn_acceptances_reserved')
  })

  it('still backfills FTS on a database without the marker', () => {
    const db = createMigratedDb()
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path) VALUES ('c', '/r')",
    )
    db.exec(
      "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('m', 'c', 'user', 'needle', 1)",
    )
    db.exec('DELETE FROM messages_fts; DELETE FROM db_markers')
    migrate(db)
    expect(db.prepare("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'needle'").get()).toEqual({
      c: 1,
    })
  })

  it('defers the slow steps until runSlowMigrations', () => {
    deferSlowMigrationsUntilWindow()
    let db = createMigratedDb()
    expect(indexes(db)).not.toContain('idx_messages_enrichable')
    runSlowMigrations()
    expect(indexes(db)).toContain('idx_messages_enrichable')
    expect(indexes(db)).toContain('idx_turn_acceptances_reserved')
    closeDb()
    db = createMigratedDb()
    expect(indexes(db)).not.toContain('idx_messages_enrichable')
    runSlowMigrations()
    expect(indexes(db)).toContain('idx_messages_enrichable')
  })
})

describe('getDisplayBodyEnrichments', () => {
  it('reads only the asked contents, and the newest row of a repeated content wins', () => {
    const db = createMigratedDb()
    db.exec(
      "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path) VALUES ('c', '/r')",
    )
    const insert = db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, display_body, pills_meta, images, timestamp) VALUES (?, 'c', 'user', ?, ?, '{}', ?, ?)",
    )
    insert.run('new', 'same', 'newer body', null, 20)
    insert.run('old', 'same', 'older body', null, 10)
    insert.run('img', 'other', null, '[{"url":"data:x"}]', 5)
    expect([...getDisplayBodyEnrichments('c')]).toEqual([
      ['other', { images: '[{"url":"data:x"}]' }],
      ['same', { displayBody: 'newer body', pillsMeta: '{}' }],
    ])
    expect([...getDisplayBodyEnrichments('c', new Set(['same']))].map(([content]) => content)).toEqual(['same'])
    expect(getDisplayBodyEnrichments('c', new Set()).size).toBe(0)
  })
})
