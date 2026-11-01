/**
 * `app:load-session` reads a transcript by its path, which is also what the
 * sidebar export uses for a chat that is not loaded. A live saved secret in
 * that transcript must come back masked, and the caller cannot pick the
 * masking scope: an unrelated or missing conversation id still masks it, and
 * the search rows it indexes hold no value either.
 */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')
const db = await import('../../src/main/db/database')
const { secretRedactor } = await import('../../src/main/secrets/secret-redactor')

const CANARY = 'sbcanary_legacyload_0123456789'
let dir: string
let transcript: string

function loadSession(...args: unknown[]): Promise<unknown> {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  registerAppHandlers(
    { handle: (c: string, h: (...a: unknown[]) => unknown) => handlers.set(c, h), emit: () => {} } as never,
    {},
  )
  return handlers.get(AppChannels.LOAD_SESSION)!(...args) as Promise<unknown>
}

beforeEach(() => {
  createMigratedDb().prepare("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')").run()
  db.createConversation('agent_owner', '/repo', 'claude-code', 'Owner')
  db.createConversation('agent_other', '/repo', 'claude-code', 'Other')
  secretRedactor.add('agent_owner', 'sec_1', 'API_KEY', Buffer.from(CANARY))
  dir = mkdtempSync(join(tmpdir(), 'sb-legacy-load-'))
  transcript = join(dir, 'session.jsonl')
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      id: 'msg_1',
      message: { content: [{ type: 'text', text: `the key is ${CANARY}` }] },
    }) + '\n',
  )
})

afterEach(() => {
  secretRedactor.clear()
  rmSync(dir, { recursive: true, force: true })
})

describe('legacy app:load-session', () => {
  it.each([
    ['the owning conversation', 'agent_owner'],
    ['an unrelated conversation', 'agent_other'],
    ['no conversation', undefined],
  ])('masks a live secret when called with %s', async (_label, conversationId) => {
    const messages = await loadSession(transcript, conversationId, 'claude-code')
    const text = JSON.stringify(messages)
    expect(text).not.toContain(CANARY)
    expect(text).toContain('[secret API_KEY]')
  })

  it('indexes no value for search', async () => {
    await loadSession(transcript, 'agent_other', 'claude-code')
    const rows = db.getMessagesForConversation('agent_other')
    expect(JSON.stringify(rows)).not.toContain(CANARY)
    expect(rows.length).toBe(1)
  })
})
