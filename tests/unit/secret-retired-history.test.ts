/**
 * A saved value that was masked in a chat's output is in the provider's
 * transcript for good. Delete now, expiry, archive or a replacement under the
 * same name must not unmask that history, across a restart too. A value that
 * never showed up in output leaves nothing behind.
 */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SecretStore } from '../../src/main/secrets/secret-store'
import { secretRedactor } from '../../src/main/secrets/secret-redactor'
import { maskStoredText } from '../../src/main/db/secret-mask'
import { addProject, createConversation, getDb } from '../../src/main/db/database'
import { removeProject } from '../../src/main/db/projects'

const CANARY = 'sbcanary_retired_0123456789'
const NEXT = 'sbcanary_retired_next_9876543210'
const LINE = `token: ${CANARY}`
let root: string
let now: number
let store: SecretStore

function save(value: string, name = 'API_KEY'): string {
  return store.save({
    threadId: 'chat-a',
    name,
    value: Buffer.from(value),
    cardId: 'card-1',
    expiresAt: now + 60_000,
  }).id
}

/** A restart: the matcher forgets everything, a new store starts. */
function restart(): void {
  store.stop()
  secretRedactor.clear()
  store = new SecretStore({ root, now: () => now, excludeFromBackup: async () => true })
  store.start()
}

function dbDump(): string {
  const db = getDb()
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  return tables
    .map(({ name }) =>
      JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all(), (_k, v) =>
        Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
      ),
    )
    .join('\n')
}

function retiredRows(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM agent_secret_retired').get() as { n: number }).n
}

beforeEach(() => {
  createMigratedDb()
  process.env.SWITCHBOARD_SECRET = 'sb-test-passphrase'
  addProject('/tmp/project', 'project')
  createConversation('chat-a', '/tmp/project', 'claude-code')
  root = join(mkdtempSync(join(tmpdir(), 'sb-secret-retired-')), 'secrets')
  now = 1_000_000
  store = new SecretStore({ root, now: () => now, excludeFromBackup: async () => true })
})

afterEach(() => {
  store.stop()
  secretRedactor.clear()
  delete process.env.SWITCHBOARD_SECRET
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    try {
      chmodSync(join(root, d), 0o700)
    } catch {
      // a file, not a folder
    }
  }
  rmSync(dirname(root), { recursive: true, force: true })
})

describe('a dropped secret that was masked in output', () => {
  it.each([
    ['delete now', (id: string) => store.remove(id)],
    [
      'expiry',
      () => {
        now += 120_000
        store.sweep()
      },
    ],
    ['archive', () => store.removeChat('chat-a')],
  ])('stays masked in history after %s and a restart', (_label, drop) => {
    const id = save(CANARY)
    expect(maskStoredText('chat-a', LINE)).toBe('token: [secret API_KEY]')
    drop(id)
    expect(store.get(id)?.deletedAt).not.toBeNull()
    expect(maskStoredText('chat-a', LINE)).toBe('token: [secret API_KEY]')
    expect(retiredRows()).toBe(1)
    expect(dbDump()).not.toContain(CANARY)
    restart()
    expect(maskStoredText('chat-a', LINE)).toBe('token: [secret API_KEY]')
  })

  it('keeps the old value masked when a new one replaces it under the same name', () => {
    save(CANARY)
    expect(maskStoredText('chat-a', LINE)).toBe('token: [secret API_KEY]')
    save(NEXT)
    expect(maskStoredText('chat-a', `${LINE} ${NEXT}`)).toBe('token: [secret API_KEY] [secret API_KEY]')
    restart()
    expect(maskStoredText('chat-a', LINE)).toBe('token: [secret API_KEY]')
  })

  it('is no live secret: the store lists it as deleted and a restart reads no file for it', () => {
    const id = save(CANARY)
    maskStoredText('chat-a', LINE)
    store.remove(id)
    expect(secretRedactor.has(id)).toBe(false)
    expect(store.listChat('chat-a').every((row) => row.deletedAt !== null)).toBe(true)
  })

  it('goes with its conversation', () => {
    const id = save(CANARY)
    maskStoredText('chat-a', LINE)
    store.remove(id)
    expect(retiredRows()).toBe(1)
    removeProject('/tmp/project')
    expect(retiredRows()).toBe(0)
  })

  it('is kept in memory only when nothing can encrypt it', () => {
    delete process.env.SWITCHBOARD_SECRET
    const id = save(CANARY)
    maskStoredText('chat-a', LINE)
    store.remove(id)
    expect(maskStoredText('chat-a', LINE)).toBe('token: [secret API_KEY]')
    expect(retiredRows()).toBe(0)
    expect(dbDump()).not.toContain(CANARY)
  })
})

describe('a dropped secret never seen in output', () => {
  it('leaves no record and no matcher', () => {
    const id = save(CANARY)
    store.remove(id)
    expect(retiredRows()).toBe(0)
    expect(secretRedactor.any()).toBe(false)
    expect(maskStoredText('chat-a', LINE)).toBe(LINE)
  })
})
