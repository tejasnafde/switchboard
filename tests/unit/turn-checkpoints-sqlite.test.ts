/** A running turn's diff-card baseline survives a restart, keyed by the root chat id. */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureTurnCheckpointSchema, sqliteTurnCheckpointStore } from '../../src/main/db/turn-checkpoints'

const root = (id: string) => (id === 'rotated' ? 'chat' : id)

describe('sqliteTurnCheckpointStore', () => {
  it('returns only a baseline an earlier process left, once', () => {
    const db = new Database(':memory:')
    ensureTurnCheckpointSchema(db)
    ensureTurnCheckpointSchema(db)
    const store = sqliteTurnCheckpointStore(() => db, root)
    store.save('rotated', { turnId: 'x-1', tree: 'T', repoRoot: '/repo', written: ['/repo/a.ts'] })
    // Written by this process: a running turn, not one a restart interrupted.
    expect(store.takeEarlier('chat')).toBeNull()
    db.prepare("UPDATE turn_checkpoints SET launch = 'earlier'").run()
    expect(store.takeEarlier('chat')).toEqual({ turnId: 'x-1', tree: 'T', repoRoot: '/repo', written: ['/repo/a.ts'] })
    expect(store.takeEarlier('chat')).toBeNull()
  })

  it('forgets a finished turn', () => {
    const db = new Database(':memory:')
    ensureTurnCheckpointSchema(db)
    const store = sqliteTurnCheckpointStore(() => db, root)
    store.save('chat', { turnId: 'x-1', tree: 'T', repoRoot: '/repo', written: [] })
    store.remove('rotated')
    expect(db.prepare('SELECT COUNT(*) AS n FROM turn_checkpoints').get()).toEqual({ n: 0 })
  })

  it("restores a row whose written paths are unreadable with none counted as the agent's", () => {
    const db = new Database(':memory:')
    ensureTurnCheckpointSchema(db)
    db.prepare("INSERT INTO turn_checkpoints VALUES ('chat', 'x-1', 'T', '/repo', 'not json', 'earlier')").run()
    expect(sqliteTurnCheckpointStore(() => db, root).takeEarlier('chat')).toEqual({
      turnId: 'x-1',
      tree: 'T',
      repoRoot: '/repo',
      written: [],
    })
  })
})
