import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatLoadTiming } from '../../src/shared/perf-chat'

const root = mkdtempSync(join(tmpdir(), 'sb-history-memo-'))
const codexHomes = [join(root, 'codex-a'), join(root, 'codex-b')]
vi.mock('../../src/main/provider/claude-session-migrate', async (importOriginal) => ({
  ...await importOriginal<object>(),
  claudeCandidateDirs: () => [join(root, 'claude')],
}))
vi.mock('../../src/main/provider/codex-session-dirs', () => ({ codexCandidateDirs: () => codexHomes }))

const { loadConversationHistory, clearMergedHistories } = await import('../../src/main/conversations/history')
const { clearJsonlCache } = await import('../../src/main/agent/jsonl-cache')
const db = await import('../../src/main/db/database')

const line = (record: unknown) => `${JSON.stringify(record)}\n`
const claudeLine = (uuid: string, role: 'user' | 'assistant', text: string, at: number) =>
  line({ type: role, uuid, timestamp: new Date(at).toISOString(), message: { role, content: [{ type: 'text', text }] } })
const codexLine = (role: 'user' | 'assistant', text: string, at: number) => line({
  timestamp: new Date(at).toISOString(),
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
})

let n = 0
function conversation(): string {
  const id = `memo-${++n}`
  db.addProject('/memo', 'Memo')
  db.createConversation(id, '/memo', 'claude-code', 'Memo')
  return id
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearMergedHistories()
  clearJsonlCache()
})

describe('merged history memo', () => {
  it('reuses the merge until a stored row is added, changed or deleted', async () => {
    const id = conversation()
    db.saveMessage('m1', id, 'user', 'first', undefined, undefined)
    const first = await loadConversationHistory(id, '/memo')
    expect(first.timing.mergeHit).toBeUndefined()
    const again = await loadConversationHistory(id, '/memo')
    expect(again.timing.mergeHit).toBe(true)
    expect(again.messages).toBe(first.messages)

    db.saveMessage('m2', id, 'assistant', 'second', undefined, undefined)
    const added = await loadConversationHistory(id, '/memo')
    expect(added.timing.mergeHit).toBeUndefined()
    expect(added.messages.map((m) => m.content)).toEqual(['first', 'second'])

    db.getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run('edited', 'm2')
    expect((await loadConversationHistory(id, '/memo')).messages.map((m) => m.content)).toEqual(['first', 'edited'])

    db.getDb().prepare('DELETE FROM messages WHERE id = ?').run('m1')
    expect((await loadConversationHistory(id, '/memo')).messages.map((m) => m.content)).toEqual(['edited'])
  })

  it('rebuilds when the transcript grows', async () => {
    const id = conversation()
    const session = `claude-${id}`
    db.recordThreadSession(session, id)
    const file = join(root, 'claude', 'projects', 'p', `${session}.jsonl`)
    mkdirSync(join(root, 'claude', 'projects', 'p'), { recursive: true })
    writeFileSync(file, claudeLine('u1', 'user', 'hello', 1_000))
    await loadConversationHistory(id, '/memo')
    expect((await loadConversationHistory(id, '/memo')).timing.mergeHit).toBe(true)

    appendFileSync(file, claudeLine('a1', 'assistant', 'hi there', 2_000))
    const grown = await loadConversationHistory(id, '/memo')
    expect(grown.timing.mergeHit).toBeUndefined()
    expect(grown.messages.map((m) => m.content)).toEqual(['hello', 'hi there'])
  })
})

describe('Codex rollout copies', () => {
  it('parses a copy that is a byte prefix of a larger one only once', async () => {
    const id = conversation()
    const session = `codex-${id}`
    db.recordThreadSession(session, id)
    const meta = line({ type: 'session_meta', payload: { id: session, cwd: '/memo' } })
    const prefix = meta + codexLine('user', 'run it', 1_000) + codexLine('assistant', 'done', 2_000)
    const rollouts = codexHomes.map((home) => join(home, 'sessions', '2026', '10', '08', `rollout-2026-10-08T10-00-00-${session}.jsonl`))
    for (const path of rollouts) mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(rollouts[0], prefix)
    writeFileSync(rollouts[1], prefix + codexLine('user', 'again', 3_000))

    const history = await loadConversationHistory(id, '/memo')
    expect(history.timing.prefixSkips).toBe(1)
    expect((history.timing as ChatLoadTiming).diskLines).toBe(4)
    expect(history.messages.map((m) => m.content)).toEqual(['run it', 'done', 'again'])
  })
})
