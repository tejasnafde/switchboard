/**
 * The SQLite store behind held peer messages: a message one backend held is
 * read back by the next one on the same file, and is gone once removed.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensurePeerHeldMessageSchema, sqliteHeldPeerMessageStore } from '../../src/main/db/peer-held-messages'
import type { HeldPeerMessage } from '../../src/shared/peer-held-messages'

const message: HeldPeerMessage = {
  id: 'pu_1',
  fromThreadId: 'w1-session',
  fromRoot: 'w1',
  fromLabel: 'Worker A',
  targetRoot: 'hub',
  targetLabel: 'Lead',
  text: 'the finding',
  heldAt: 1000,
}

describe('sqliteHeldPeerMessageStore', () => {
  it('keeps a held message across a restart until it is removed', () => {
    const db = new Database(':memory:')
    ensurePeerHeldMessageSchema(db)
    sqliteHeldPeerMessageStore(() => db).put(message)
    sqliteHeldPeerMessageStore(() => db).put({ ...message, id: 'pu_2', heldAt: 2000 })
    const after = sqliteHeldPeerMessageStore(() => db)
    expect(after.all()).toEqual([message, { ...message, id: 'pu_2', heldAt: 2000 }])
    after.remove('pu_1')
    expect(
      sqliteHeldPeerMessageStore(() => db)
        .all()
        .map((m) => m.id),
    ).toEqual(['pu_2'])
    db.close()
  })
})
