import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SECRET_MAX_BYTES, SecretStore, excludeFromTimeMachine } from '../../src/main/secrets/secret-store'
import { SecretRedactor } from '../../src/main/secrets/secret-redactor'
import { getAgentSecret, getSecretDirId, listLiveAgentSecrets } from '../../src/main/db/agent-secrets'
import { archiveConversation, createConversation, recordThreadSession } from '../../src/main/db/conversations'
import { addProject, removeProject } from '../../src/main/db/database'
import { onConversationArchived } from '../../src/main/db/archive-events'

// Windows has no POSIX modes, and a symlink needs a privilege there.
const posixIt = it.skipIf(process.platform === 'win32')
const VALUE = Buffer.from('sb-test-not-a-secret')
let root: string
let now: number
let store: SecretStore

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

function listAs700(dir: string): string[] {
  chmodSync(dir, 0o700)
  try {
    return readdirSync(dir).sort()
  } finally {
    chmodSync(dir, 0o300)
  }
}

beforeEach(() => {
  createMigratedDb()
  root = join(mkdtempSync(join(tmpdir(), 'sb-secret-test-')), 'secrets')
  now = 1_000_000
  store = new SecretStore({ root, now: () => now, excludeFromBackup: async () => true })
})

afterEach(() => {
  store.stop()
  const parent = dirname(root)
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    try {
      chmodSync(join(root, d), 0o700)
    } catch {
      // a file, not a folder
    }
  }
  rmSync(parent, { recursive: true, force: true })
})

describe('SecretStore', () => {
  posixIt('makes the root 0700 with a Spotlight marker and a 0300 chat folder named by 128 random bits', () => {
    const excluded: string[] = []
    store = new SecretStore({ root, now: () => now, excludeFromBackup: async (d) => (excluded.push(d), true) })
    const dir = store.chatDir('chat-a')
    expect(mode(root)).toBe(0o700)
    expect(existsSync(join(root, '.metadata_never_index'))).toBe(true)
    expect(excluded).toEqual([root])
    expect(mode(dir)).toBe(0o300)
    expect(basename(dir)).toMatch(/^[0-9a-f]{32}$/)
    expect(() => readdirSync(dir)).toThrow()
    expect(store.chatDir('chat-a')).toBe(dir)
    expect(store.chatDir('chat-b')).not.toBe(dir)
  })

  posixIt('saves a 0600 file with the exact bytes and no .partial left, and records no value', () => {
    const saved = store.save({
      threadId: 'chat-a',
      name: 'TAILSCALE_AUTHKEY',
      value: VALUE,
      cardId: 'sbsec_1',
      expiresAt: now + 3_600_000,
    })
    expect(readFileSync(saved.file)).toEqual(VALUE)
    expect(mode(saved.file)).toBe(0o600)
    expect(listAs700(dirname(saved.file))).toEqual(['TAILSCALE_AUTHKEY'])
    const row = getAgentSecret(saved.id)!
    expect(row).toMatchObject({ name: 'TAILSCALE_AUTHKEY', cardId: 'sbsec_1', deletedAt: null })
    expect(JSON.stringify(row)).not.toContain(VALUE.toString())
  })

  it('refuses a bad name and an empty or oversized value', () => {
    const base = { threadId: 'chat-a', cardId: 'c', expiresAt: now + 1 }
    expect(() => store.save({ ...base, name: 'lower', value: VALUE })).toThrow()
    expect(() => store.save({ ...base, name: '../X', value: VALUE })).toThrow()
    expect(() => store.save({ ...base, name: 'OK_NAME', value: Buffer.alloc(0) })).toThrow()
    expect(() => store.save({ ...base, name: 'OK_NAME', value: Buffer.alloc(16 * 1024 + 1) })).toThrow()
  })

  posixIt('never follows a symlink planted at the .partial path', () => {
    const dir = store.chatDir('chat-a')
    const target = join(dirname(root), 'outside')
    writeFileSync(target, 'untouched')
    chmodSync(dir, 0o700)
    symlinkSync(target, join(dir, 'KEY_ONE.partial'))
    chmodSync(dir, 0o300)
    expect(() =>
      store.save({ threadId: 'chat-a', name: 'KEY_ONE', value: VALUE, cardId: 'c', expiresAt: now + 1 }),
    ).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('replaces the file and retires the old row on a second save of the same name', () => {
    const first = store.save({ threadId: 'chat-a', name: 'KEY_ONE', value: VALUE, cardId: 'c1', expiresAt: now + 1000 })
    const second = store.save({
      threadId: 'chat-a',
      name: 'KEY_ONE',
      value: Buffer.from('second-value-xyz'),
      cardId: 'c2',
      expiresAt: now + 2000,
    })
    expect(second.file).toBe(first.file)
    expect(readFileSync(second.file, 'utf8')).toBe('second-value-xyz')
    expect(getAgentSecret(first.id)!.deletedAt).not.toBeNull()
    expect(listLiveAgentSecrets('chat-a').map((r) => r.id)).toEqual([second.id])
  })

  it('deletes the file when the row cannot be recorded', () => {
    createMigratedDb().exec('DROP TABLE agent_secrets')
    expect(() =>
      store.save({ threadId: 'chat-a', name: 'KEY_ONE', value: VALUE, cardId: 'c', expiresAt: now + 1 }),
    ).toThrow()
    expect(listAs700(join(root, getSecretDirId('chat-a')!))).toEqual([])
  })

  it('extends, deletes now, and expires on its timer', () => {
    vi.useFakeTimers()
    try {
      const expired: string[] = []
      store = new SecretStore({
        root,
        now: () => now,
        excludeFromBackup: async () => true,
        onExpired: (r) => expired.push(r.id),
      })
      const a = store.save({ threadId: 'chat-a', name: 'KEY_A', value: VALUE, cardId: 'c', expiresAt: now + 1000 })
      const b = store.save({ threadId: 'chat-a', name: 'KEY_B', value: VALUE, cardId: 'c', expiresAt: now + 1000 })
      expect(store.extend(a.id, now + 5000)).toBe(true)
      now += 1000
      vi.advanceTimersByTime(1000)
      expect(existsSync(b.file)).toBe(false)
      expect(expired).toEqual([b.id])
      expect(existsSync(a.file)).toBe(true)
      expect(store.remove(a.id)).toBe(true)
      expect(existsSync(a.file)).toBe(false)
      expect(store.remove(a.id)).toBe(false)
      expect(store.extend(a.id, now + 9000)).toBe(false)
      expect(expired).toEqual([b.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes every file, the folder and the dir row when the chat is archived', () => {
    const a = store.save({ threadId: 'chat-a', name: 'KEY_A', value: VALUE, cardId: 'c', expiresAt: now + 1000 })
    const other = store.save({ threadId: 'chat-b', name: 'KEY_A', value: VALUE, cardId: 'c', expiresAt: now + 1000 })
    store.removeChat('chat-a')
    expect(existsSync(dirname(a.file))).toBe(false)
    expect(getSecretDirId('chat-a')).toBeNull()
    expect(listLiveAgentSecrets('chat-a')).toEqual([])
    expect(existsSync(other.file)).toBe(true)
  })

  posixIt('reads a live file back for masking after a restart, but not one grown past the size limit', () => {
    const a = store.save({ threadId: 'chat-a', name: 'KEY_A', value: VALUE, cardId: 'c', expiresAt: now + 60_000 })
    const b = store.save({ threadId: 'chat-a', name: 'KEY_B', value: VALUE, cardId: 'c', expiresAt: now + 60_000 })
    writeFileSync(b.file, Buffer.alloc(SECRET_MAX_BYTES + 1, 'x'))
    store.stop()
    const redactor = new SecretRedactor()
    store = new SecretStore({ root, now: () => now, excludeFromBackup: async () => true, redactor })
    store.sweep()
    expect(redactor.has(a.id)).toBe(true)
    expect(redactor.has(b.id)).toBe(false)
  })

  it('sweeps expired files, orphan folders, .partial files and unknown files, and keeps live ones', () => {
    const live = store.save({
      threadId: 'chat-a',
      name: 'KEY_LIVE',
      value: VALUE,
      cardId: 'c',
      expiresAt: now + 10_000,
    })
    const old = store.save({ threadId: 'chat-a', name: 'KEY_OLD', value: VALUE, cardId: 'c', expiresAt: now + 10 })
    const dir = dirname(live.file)
    chmodSync(dir, 0o700)
    writeFileSync(join(dir, 'KEY_LIVE.partial'), 'x')
    writeFileSync(join(dir, 'STRAY'), 'x')
    chmodSync(dir, 0o300)
    const orphan = join(root, 'ab'.repeat(16))
    mkdirSync(orphan, { mode: 0o700 })
    writeFileSync(join(orphan, 'LEFT'), 'x')
    chmodSync(orphan, 0o300)
    writeFileSync(join(root, 'junk'), 'x')

    now += 100
    // A fresh process: no timers armed, as after a crash.
    const restarted = new SecretStore({ root, now: () => now, excludeFromBackup: async () => true })
    restarted.sweep()
    restarted.stop()

    expect(listAs700(dir)).toEqual(['KEY_LIVE'])
    expect(existsSync(old.file)).toBe(false)
    expect(getAgentSecret(old.id)!.deletedAt).not.toBeNull()
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(root, 'junk'))).toBe(false)
    expect(readdirSync(root).sort()).toEqual(['.metadata_never_index', basename(dir)])
  })

  posixIt('unlinks a symlink in the root without touching its target', () => {
    store.chatDir('chat-a')
    const target = join(dirname(root), 'outside')
    writeFileSync(target, 'untouched', { mode: 0o644 })
    symlinkSync(target, join(root, 'link'))
    store.sweep()
    expect(existsSync(join(root, 'link'))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(mode(target)).toBe(0o644)
  })

  it('deletes the files and folder of an archived chat, and keeps a live chat and a chat with no row', () => {
    addProject('/tmp/project', 'project')
    createConversation('chat-archived', '/tmp/project', 'claude-code')
    createConversation('chat-live', '/tmp/project', 'claude-code')
    const save = (threadId: string) =>
      store.save({ threadId, name: 'KEY_A', value: VALUE, cardId: 'c', expiresAt: now + 60_000 })
    const gone = save('chat-archived')
    const live = save('chat-live')
    const unknown = save('chat-no-row')
    archiveConversation('chat-archived')
    store.sweep()
    expect(existsSync(dirname(gone.file))).toBe(false)
    expect(getSecretDirId('chat-archived')).toBeNull()
    expect(getAgentSecret(gone.id)!.deletedAt).not.toBeNull()
    expect(getAgentSecret(live.id)!.deletedAt).toBeNull()
    expect(getAgentSecret(unknown.id)!.deletedAt).toBeNull()
    expect(listAs700(dirname(live.file))).toEqual(['KEY_A'])
  })

  it("deletes a chat's file and folder when its project is removed", () => {
    addProject('/tmp/project', 'project')
    createConversation('chat-p', '/tmp/project', 'claude-code')
    const off = onConversationArchived((id) => store.removeChat(id))
    try {
      const saved = store.save({
        threadId: 'chat-p',
        name: 'KEY_A',
        value: Buffer.from('sbcanary_4_0123456789'),
        cardId: 'c',
        expiresAt: now + 60_000,
      })
      removeProject('/tmp/project')
      expect(existsSync(dirname(saved.file))).toBe(false)
      expect(getAgentSecret(saved.id)!.deletedAt).not.toBeNull()
      expect(getSecretDirId('chat-p')).toBeNull()
    } finally {
      off()
    }
  })

  it("the next sweep deletes a removed project's secrets when the delete at removal failed", () => {
    addProject('/tmp/project', 'project')
    createConversation('chat-p', '/tmp/project', 'claude-code')
    const off = onConversationArchived(() => {
      throw new Error('simulated failure')
    })
    try {
      const saved = store.save({
        threadId: 'chat-p',
        name: 'KEY_A',
        value: Buffer.from('sbcanary_4_0123456789'),
        cardId: 'c',
        expiresAt: now + 60_000,
      })
      const provisional = store.chatDir('chat-no-row-yet')
      removeProject('/tmp/project')
      expect(existsSync(dirname(saved.file))).toBe(true)
      store.sweep()
      expect(existsSync(dirname(saved.file))).toBe(false)
      expect(getAgentSecret(saved.id)!.deletedAt).not.toBeNull()
      expect(getSecretDirId('chat-p')).toBeNull()
      expect(existsSync(provisional)).toBe(true)
      expect(getSecretDirId('chat-no-row-yet')).not.toBeNull()
    } finally {
      off()
    }
  })

  it("keeps the secrets of a removed project's chat once the chat is added back", () => {
    addProject('/tmp/project', 'project')
    createConversation('chat-p', '/tmp/project', 'claude-code')
    store.chatDir('chat-p')
    const off = onConversationArchived(() => {
      throw new Error('simulated failure')
    })
    try {
      removeProject('/tmp/project')
    } finally {
      off()
    }
    addProject('/tmp/project', 'project')
    createConversation('chat-p', '/tmp/project', 'claude-code')
    const saved = store.save({ threadId: 'chat-p', name: 'KEY_A', value: VALUE, cardId: 'c', expiresAt: now + 60_000 })
    store.sweep()
    expect(getAgentSecret(saved.id)!.deletedAt).toBeNull()
    expect(existsSync(saved.file)).toBe(true)
  })

  posixIt('refuses to save through a chat folder replaced by a symlink, and leaves the target alone', () => {
    const dir = store.chatDir('chat-a')
    const outside = join(dirname(root), 'repo')
    mkdirSync(outside, { mode: 0o755 })
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true })
    symlinkSync(outside, dir)
    const save = () =>
      store.save({
        threadId: 'chat-a',
        name: 'KEY_A',
        value: Buffer.from('sbcanary_11_0123456789'),
        cardId: 'c',
        expiresAt: now + 60_000,
      })
    expect(save).toThrow(/not a real folder/)
    expect(readdirSync(outside)).toEqual([])
    expect(mode(outside)).toBe(0o755)
    store.removeChat('chat-a')
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    expect(mode(outside)).toBe(0o755)
  })

  posixIt('refuses a secrets root that is a symlink, and leaves the target alone', () => {
    const outside = join(dirname(root), 'repo')
    mkdirSync(outside, { mode: 0o755 })
    symlinkSync(outside, root)
    expect(() => store.chatDir('chat-a')).toThrow(/not a real folder/)
    expect(readdirSync(outside)).toEqual([])
    expect(mode(outside)).toBe(0o755)
  })

  it('notes a failed backup exclusion for the card, and retries it on the next sweep', async () => {
    let ok = false
    let calls = 0
    store = new SecretStore({
      root,
      now: () => now,
      excludeFromBackup: async () => (calls++, ok),
    })
    store.chatDir('chat-a')
    await vi.waitFor(() => expect(store.limits()).toEqual({ backupNotExcluded: true }))
    ok = true
    store.sweep()
    await vi.waitFor(() => expect(store.limits()).toEqual({}))
    expect(calls).toBe(2)
  })

  it('names Windows as the host for the card', () => {
    store = new SecretStore({ root, now: () => now, excludeFromBackup: async () => null, platform: 'win32' })
    expect(store.limits()).toEqual({ hostPlatform: 'win32' })
  })

  it('does nothing when no secret was ever saved', () => {
    store.sweep()
    expect(existsSync(root)).toBe(false)
  })

  it('keys the folder and the rows by the root conversation across a session id rotation', () => {
    const dir = store.chatDir('agent_123')
    recordThreadSession('rotated-uuid', 'agent_123')
    expect(store.chatDir('rotated-uuid')).toBe(dir)
    const saved = store.save({
      threadId: 'rotated-uuid',
      name: 'KEY_A',
      value: VALUE,
      cardId: 'c',
      expiresAt: now + 1000,
    })
    expect(listLiveAgentSecrets('agent_123').map((r) => r.id)).toEqual([saved.id])
    store.removeChat('rotated-uuid')
    expect(getSecretDirId('agent_123')).toBeNull()
  })

  it('reads one row and every row of a chat, deleted ones too, by the root id', () => {
    const first = store.save({
      threadId: 'agent_9',
      name: 'KEY_ONE',
      value: VALUE,
      cardId: 'c1',
      expiresAt: now + 1000,
    })
    now += 1
    const second = store.save({
      threadId: 'agent_9',
      name: 'KEY_TWO',
      value: VALUE,
      cardId: 'c2',
      expiresAt: now + 1000,
    })
    store.save({ threadId: 'other', name: 'KEY_ONE', value: VALUE, cardId: 'c3', expiresAt: now + 1000 })
    store.remove(first.id)
    recordThreadSession('rotated-9', 'agent_9')
    expect(store.get(first.id)).toMatchObject({ rootThreadId: 'agent_9', cardId: 'c1' })
    expect(store.get(first.id)!.deletedAt).not.toBeNull()
    expect(store.get('sec_missing')).toBeNull()
    expect(store.listChat('rotated-9').map((r) => r.id)).toEqual([second.id, first.id])
  })

  // Design 4.4: saved under the root id, the rotated id finds the same folder, and extend, delete and list go by root.
  it('finds a secret saved under the root id through a rotated session id', () => {
    const saved = store.save({ threadId: 'agent_456', name: 'KEY_B', value: VALUE, cardId: 'c', expiresAt: now + 1000 })
    recordThreadSession('rotated-uuid-2', 'agent_456')
    expect(join(store.chatDir('rotated-uuid-2'), 'KEY_B')).toBe(saved.file)
    expect(listLiveAgentSecrets('rotated-uuid-2').map((r) => r.id)).toEqual([saved.id])
    expect(store.extend(saved.id, now + 5000)).toBe(true)
    expect(listLiveAgentSecrets('agent_456')[0].expiresAt).toBe(now + 5000)
    expect(store.remove(saved.id)).toBe(true)
    expect(listLiveAgentSecrets('rotated-uuid-2')).toEqual([])
    expect(listLiveAgentSecrets('agent_456')).toEqual([])
  })
})

describe('excludeFromTimeMachine', () => {
  const ok = (stdout = '') => Promise.resolve(stdout)
  it('adds the exclusion and checks it took', async () => {
    const calls: string[][] = []
    const run = (args: string[]) => (calls.push(args), ok(args[0] === 'isexcluded' ? '[Excluded]    /x\n' : ''))
    expect(await excludeFromTimeMachine('/x', run, 'darwin')).toBe(true)
    expect(calls).toEqual([
      ['addexclusion', '/x'],
      ['isexcluded', '/x'],
    ])
  })

  it('is false when tmutil fails or the folder is still included', async () => {
    expect(await excludeFromTimeMachine('/x', () => Promise.reject(new Error('tmutil failed')), 'darwin')).toBe(false)
    expect(
      await excludeFromTimeMachine('/x', (args) => ok(args[0] === 'isexcluded' ? '[Included]  /x' : ''), 'darwin'),
    ).toBe(false)
  })

  it('is null off macOS, with no tmutil run', async () => {
    const run = vi.fn(() => ok())
    expect(await excludeFromTimeMachine('/x', run, 'win32')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})
