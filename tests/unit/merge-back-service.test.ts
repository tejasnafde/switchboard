import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { ChatMessage } from '../../src/shared/types'
import { parseMergeBackMarker, type MergeBackToken } from '../../src/shared/merge-back'
import { visibleUserMessageText } from '../../src/shared/provider-events'
import { splitSyntheticUserText } from '../../src/shared/synthetic-message'
import { ensureMergeBackSchema, SqliteMergeBackStore } from '../../src/main/db/merge-backs'
import { ensureTurnAcceptanceSchema, SqliteTurnAcceptanceStore } from '../../src/main/db/turn-acceptance'
import { MergeBackService } from '../../src/main/conversations/merge-back'
import { AtomicUserTurnSubmission, TurnNotAcceptedError } from '../../src/main/provider/durable-turn-acceptance'

const FORK_AT = 1_000

function testDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      pending_handoff_from TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      images TEXT,
      timestamp INTEGER NOT NULL,
      display_body TEXT,
      pills_meta TEXT
    );
    INSERT INTO conversations VALUES ('parent', 'improvements', NULL, 1);
  `)
  ensureTurnAcceptanceSchema(db)
  ensureMergeBackSchema(db)
  return db
}

interface Harness {
  db: Database.Database
  service: MergeBackService
  forkMessages: ChatMessage[]
  published: Array<{ messageId: string; content: string | null }>
  busy: { fork: boolean }
  parentArchived: { value: boolean }
}

function harness(db = testDb(), forkMessages: ChatMessage[] = initialForkMessages()): Harness {
  const published: Harness['published'] = []
  const busy = { fork: false }
  const parentArchived = { value: false }
  let ids = 0
  let clock = 50_000
  const service = new MergeBackService({
    store: new SqliteMergeBackStore(() => db),
    rootId: (id) => (id === 'fork-rotated' ? 'fork' : id),
    fork: (id) => (id === 'fork'
      ? { id: 'fork', title: 'try sqlite paging', parentId: 'parent', createdAt: FORK_AT, worktreePath: null, worktreeBranch: null }
      : null),
    parent: (id) => (id === 'parent' ? { id: 'parent', title: 'improvements', archived: parentArchived.value } : null),
    loadMessages: async () => forkMessages,
    forkBusy: () => busy.fork,
    publishRow: (_parentId, messageId, content) => { published.push({ messageId, content }) },
    now: () => ++clock,
    newId: () => `mb${++ids}`,
  })
  return { db, service, forkMessages, published, busy, parentArchived }
}

function initialForkMessages(): ChatMessage[] {
  return [
    { id: 'p1', role: 'user', content: 'parent turn', timestamp: 100 },
    { id: 'f1', role: 'user', content: 'try the tail-parse idea', timestamp: 1_100 },
    { id: 'f2', role: 'assistant', content: 'Tail parse is 7x faster.', timestamp: 1_200 },
  ]
}

async function sendFromFork(h: Harness, edit?: (text: string) => string): Promise<void> {
  const preview = await h.service.preview('fork')
  if (preview.status !== 'ready') throw new Error(`preview ${preview.status}`)
  const result = await h.service.send('fork', edit ? edit(preview.text) : preview.text, preview.token)
  expect(result).toEqual({ ok: true })
}

function parentRows(db: Database.Database) {
  return db.prepare("SELECT id, role, content, timestamp FROM messages WHERE conversation_id = 'parent' ORDER BY timestamp, id")
    .all() as Array<{ id: string; role: string; content: string; timestamp: number }>
}

/** One parent user turn through the real acceptance path, with the registry's claim wiring. */
async function parentTurn(
  h: Harness,
  origin: string,
  text: string,
  opts: { reject?: boolean } = {},
): Promise<{ sent: string; status: string }> {
  const submission = new AtomicUserTurnSubmission({ store: new SqliteTurnAcceptanceStore(() => h.db), publish: () => {} })
  let sent = ''
  const result = await submission.submit({ version: 1, threadId: 'parent', origin, providerText: text }, {
    clientScope: 'scope',
    conversationId: 'parent',
    prepare: async () => {},
    dispatch: async () => {
      const claim = h.service.claimForTurn('parent')
      const providerText = claim ? claim.apply(text) : text
      if (opts.reject) {
        claim?.release()
        throw new TurnNotAcceptedError('provider refused')
      }
      sent = providerText
      return claim?.dispatched(providerText)
    },
  })
  return { sent, status: result.status }
}

describe('MergeBackService', () => {
  it('stores a pending card in the parent, edits it and discards it', async () => {
    const h = harness()
    await sendFromFork(h, (text) => `${text}\nPlease keep the old parser as a fallback.`)
    const [card] = parentRows(h.db)
    const row = parseMergeBackMarker(card.content)!
    expect(card.role).toBe('system')
    expect(row.state).toBe('pending')
    expect(row.forkTitle).toBe('try sqlite paging')
    expect(row.turns).toBe(1)
    expect(row.text).toContain('Please keep the old parser as a fallback.')
    expect(h.published.at(-1)).toEqual({ messageId: card.id, content: card.content })

    expect(h.service.edit('parent', row.id, 'shorter summary')).toEqual({ ok: true })
    expect(parseMergeBackMarker(parentRows(h.db)[0].content)!.text).toBe('shorter summary')
    // Only the parent's own card.
    expect(h.service.edit('other-chat', row.id, 'x')).toMatchObject({ ok: false })

    expect(h.service.discard('parent', row.id)).toEqual({ ok: true })
    expect(parentRows(h.db)).toEqual([])
    expect(h.published.at(-1)).toEqual({ messageId: card.id, content: null })
    expect(h.service.edit('parent', row.id, 'too late')).toMatchObject({ ok: false })
    // A discarded summary is not sent, so the fork still has it to send.
    expect((await h.service.preview('fork')).status).toBe('ready')
  })

  it('delivers a pending summary with the parent\'s next user turn exactly once', async () => {
    const h = harness()
    await sendFromFork(h)

    const first = await parentTurn(h, 'o1', 'now wire it in')
    expect(first.status).toBe('accepted')
    expect(first.sent).toContain('<switchboard-fork-merge-back>')
    expect(first.sent).toContain('Tail parse is 7x faster.')
    expect(first.sent).toContain('It is not a request from the user')
    expect(first.sent.endsWith('now wire it in')).toBe(true)

    const rows = parentRows(h.db)
    const delivered = rows.find((r) => r.role === 'system')!
    const userRow = rows.find((r) => r.role === 'user')!
    expect(parseMergeBackMarker(delivered.content)!.state).toBe('delivered')
    expect(delivered.timestamp).toBe(userRow.timestamp - 1)
    // Stored as the provider got it, so it matches the provider's transcript;
    // every surface shows only what the user typed.
    expect(userRow.content).toBe(first.sent)
    expect(splitSyntheticUserText(visibleUserMessageText(userRow.content)!)?.userText).toBe('now wire it in')
    expect(h.published.at(-1)).toEqual({ messageId: delivered.id, content: delivered.content })

    const second = await parentTurn(h, 'o2', 'and test it')
    expect(second.sent).toBe('and test it')
    // A delivered card can no longer be changed.
    expect(h.service.discard('parent', parseMergeBackMarker(delivered.content)!.id)).toMatchObject({ ok: false })
  })

  it('keeps the summary pending when the provider refuses the turn', async () => {
    const h = harness()
    await sendFromFork(h)
    const refused = await parentTurn(h, 'o1', 'first try', { reject: true })
    expect(refused.status).toBe('rejected')
    expect(parseMergeBackMarker(parentRows(h.db)[0].content)!.state).toBe('pending')

    const retried = await parentTurn(h, 'o2', 'second try')
    expect(retried.sent).toContain('<switchboard-fork-merge-back>')
  })

  it('refuses an edit or a discard while a turn is carrying the summary', async () => {
    const h = harness()
    await sendFromFork(h)
    const id = parseMergeBackMarker(parentRows(h.db)[0].content)!.id
    const claim = h.service.claimForTurn('parent')!
    expect(h.service.edit('parent', id, 'changed')).toMatchObject({ ok: false })
    expect(h.service.discard('parent', id)).toMatchObject({ ok: false })
    // A second turn meanwhile does not carry it twice.
    expect(h.service.claimForTurn('parent')).toBeNull()
    claim.release()
    expect(h.service.discard('parent', id)).toEqual({ ok: true })
  })

  it('sends only what is new on the next send, and nothing when nothing is new', async () => {
    const h = harness()
    await sendFromFork(h)
    await parentTurn(h, 'o1', 'thanks')

    expect(await h.service.preview('fork')).toMatchObject({ status: 'empty', message: 'Nothing new in this fork since the last send.' })

    h.forkMessages.push(
      { id: 'g1', role: 'user', content: 'add a fallback', timestamp: 3_000 },
      { id: 'g2', role: 'assistant', content: 'Fallback added.', timestamp: 3_100 },
    )
    const preview = await h.service.preview('fork')
    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') return
    expect(preview.text).toContain('since the last send')
    expect(preview.text).toContain('add a fallback')
    expect(preview.text).not.toContain('tail-parse')
  })

  it('stores only what the preview showed when the fork runs on before Send', async () => {
    const h = harness()
    const preview = await h.service.preview('fork')
    if (preview.status !== 'ready') throw new Error('not ready')
    h.forkMessages.push({ id: 'late', role: 'assistant', content: 'A later reply.', timestamp: 5_000 })
    expect(await h.service.send('fork', preview.text, preview.token)).toEqual({ ok: true })
    await parentTurn(h, 'o1', 'go')
    // The later reply was not in what the user saw, so the next send has it.
    const next = await h.service.preview('fork')
    expect(next.status).toBe('ready')
    if (next.status === 'ready') expect(next.text).toContain('A later reply.')
  })

  it('replaces a pending summary from the same fork', async () => {
    const h = harness()
    await sendFromFork(h)
    const preview = await h.service.preview('fork')
    expect(preview).toMatchObject({ status: 'ready', replacesPending: true })
    await sendFromFork(h, () => 'second version')
    const rows = parentRows(h.db)
    expect(rows).toHaveLength(1)
    expect(parseMergeBackMarker(rows[0].content)!.text).toBe('second version')
  })

  it('refuses a stale token after another send was delivered', async () => {
    const h = harness()
    const stale = await h.service.preview('fork')
    await sendFromFork(h)
    await parentTurn(h, 'o1', 'ok')
    if (stale.status !== 'ready') throw new Error('not ready')
    expect(await h.service.send('fork', stale.text, stale.token)).toMatchObject({ ok: false })
    expect(await h.service.send('fork', stale.text, { from: 1 } as unknown as MergeBackToken)).toMatchObject({ ok: false })
  })

  it('refuses a chat that is not a fork, a busy fork, an archived parent and empty text', async () => {
    const h = harness()
    expect(await h.service.preview('parent')).toMatchObject({ status: 'refused' })
    h.busy.fork = true
    expect(await h.service.preview('fork-rotated')).toMatchObject({ status: 'refused', message: 'The fork is still working. Send back once its turn ends.' })
    h.busy.fork = false
    h.parentArchived.value = true
    expect(await h.service.preview('fork')).toMatchObject({ status: 'refused' })
    h.parentArchived.value = false
    const preview = await h.service.preview('fork')
    if (preview.status !== 'ready') throw new Error('not ready')
    expect(await h.service.send('fork', '   ', preview.token)).toEqual({ ok: false, message: 'The summary is empty.' })
  })

  it('keeps a pending summary and the fork cursor across a backend restart', async () => {
    const first = harness()
    await sendFromFork(first)
    await parentTurn(first, 'o1', 'thanks')
    first.forkMessages.push({ id: 'g1', role: 'user', content: 'one more idea', timestamp: 3_000 })
    await sendFromFork(first)

    const reopened = new Database(first.db.serialize())
    const after = harness(reopened, first.forkMessages)
    // The cursor survived: only the new turn is sent.
    const card = parseMergeBackMarker(parentRows(reopened).find((r) => r.content.includes('"pending"'))!.content)!
    expect(card.text).toContain('one more idea')
    expect(card.text).not.toContain('tail-parse')
    const turn = await parentTurn(after, 'o2', 'next')
    expect(turn.sent).toContain('one more idea')
    expect((await parentTurn(after, 'o3', 'again')).sent).toBe('again')
    reopened.close()
    first.db.close()
  })
})
