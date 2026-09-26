import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsFileSync } from '../../src/main/settings-file'
import type { SettingsFileOp, SettingsFileStatus, SettingsSnapshot } from '@shared/settings-file'

/** An in-memory settings DB behind the sync, applying ops the way the desktop glue does. */
function fakeDb(initial: SettingsSnapshot = { settings: {}, projects: {}, keyboard: {} }) {
  const db = structuredClone(initial) as { settings: Record<string, string>; projects: Record<string, Record<string, string>>; keyboard: Record<string, unknown> }
  const applied: SettingsFileOp[][] = []
  return {
    db,
    applied,
    readSnapshot: () => structuredClone(db),
    applyOps: (ops: SettingsFileOp[]) => {
      applied.push(ops)
      for (const op of ops) {
        if (op.kind === 'set') db.settings[op.key] = op.value
        else if (op.kind === 'remove') delete db.settings[op.key]
        else if (op.kind === 'project-set') (db.projects[op.projectPath] ??= {})[op.key] = op.value
        else if (op.kind === 'project-remove') delete db.projects[op.projectKey]?.[op.key]
        else db.keyboard = JSON.parse(op.value)
      }
      return ops.map((op) => ('key' in op ? op.key : 'keyboard.overrides'))
    },
  }
}

let dir: string
let sync: SettingsFileSync
let statuses: SettingsFileStatus[]
let store: ReturnType<typeof fakeDb>
const log = { info: vi.fn(), warn: vi.fn() }

function make(initial?: SettingsSnapshot) {
  store = fakeDb(initial)
  statuses = []
  sync = new SettingsFileSync({
    dir,
    readSnapshot: store.readSnapshot,
    projectLabel: (key) => key,
    projectKey: (path) => path,
    applyOps: store.applyOps,
    onStatus: (status) => statuses.push(status),
    log,
    debounceMs: 5,
  })
  return sync
}

const file = () => join(dir, 'settings.json')
const readJson = () => JSON.parse(readFileSync(file(), 'utf8'))
/** Write as an editor would, with an mtime later than anything before it. */
function userWrite(content: string) {
  writeFileSync(file(), content)
  const later = new Date(Date.now() + 5_000)
  utimesSync(file(), later, later)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-settings-file-test-'))
})

afterEach(() => {
  sync?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('SettingsFileSync', () => {
  it('open writes the file from the DB and the schema beside it', async () => {
    make({ settings: { theme: 'light' }, projects: {}, keyboard: {} })
    const path = await sync.open()
    expect(path).toBe(file())
    expect(readJson()).toEqual({ $schema: './settings.schema.json', settings: { theme: 'light' }, projects: {}, keyboard: {} })
    expect(JSON.parse(readFileSync(join(dir, 'settings.schema.json'), 'utf8')).title).toBe('Switchboard settings')
  })

  it('applies a save, and ignores the change its own write causes', async () => {
    make()
    await sync.open()
    // Our own write reaching the watcher: same content, nothing to apply.
    await sync.applyFile()
    expect(store.applied).toEqual([])

    userWrite(JSON.stringify({ settings: { theme: 'light', 'chat.followUpDefault': 'queue' } }))
    await sync.applyFile()
    expect(store.db.settings).toEqual({ theme: 'light', 'chat.followUpDefault': 'queue' })
    expect(statuses.at(-1)).toMatchObject({ parseError: null, skipped: [] })
  })

  it('does not rewrite the file for the DB writes its own apply makes', async () => {
    make()
    // As in the desktop glue: every write the apply makes reports back through onSettingChanged.
    const applyOps = store.applyOps
    store.applyOps = (ops) => {
      const keys = applyOps(ops)
      keys.forEach(() => sync.onDbChanged())
      return keys
    }
    sync = new SettingsFileSync({
      dir, readSnapshot: store.readSnapshot, projectLabel: (k) => k, projectKey: (p) => p,
      applyOps: (ops) => store.applyOps(ops), onStatus: () => {}, log, debounceMs: 5,
    })
    await sync.open()
    const content = JSON.stringify({ settings: { theme: 'light', 'defaultSessionEnvMode': 'local' } })
    userWrite(content)
    await sync.applyFile()
    await sync.flush()
    expect(store.db.settings.theme).toBe('light')
    // Not normalised (the default it holds stays), so the user's text is untouched.
    expect(readFileSync(file(), 'utf8')).toBe(content)
  })

  it('invalid JSON applies nothing, reports it, and is never overwritten', async () => {
    make({ settings: { theme: 'light' }, projects: {}, keyboard: {} })
    await sync.open()
    userWrite('{ "settings": { "theme": ')
    await sync.applyFile()
    expect(store.applied).toEqual([])
    expect(statuses.at(-1)?.parseError).toMatch(/^not valid JSON/)

    // A UI change while the file is broken: skipped and reported.
    store.db.settings.theme = 'translucent'
    sync.onDbChanged()
    await sync.flush()
    expect(readFileSync(file(), 'utf8')).toBe('{ "settings": { "theme": ')
    expect(statuses.at(-1)?.writeSkipped).toBe(true)

    // Reopening leaves it too.
    await sync.open()
    expect(readFileSync(file(), 'utf8')).toBe('{ "settings": { "theme": ')
  })

  it('reports skipped entries and applies the rest', async () => {
    make()
    await sync.open()
    userWrite(JSON.stringify({ settings: { theme: 'neon', notificationsEnabled: false }, keyboard: { 'app.search': ['Mod+Q'] } }))
    await sync.applyFile()
    expect(store.db.settings).toEqual({ notificationsEnabled: 'false' })
    expect(statuses.at(-1)?.skipped.map((s) => s.entry)).toEqual(['settings.theme', 'keyboard.app.search'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('settings.json skipped settings.theme'))
  })

  it('rewrites the file when a setting changes elsewhere', async () => {
    make()
    await sync.open()
    store.db.settings['chat.showFileDiffs'] = 'true'
    sync.onDbChanged()
    await sync.flush()
    expect(readJson().settings).toEqual({ 'chat.showFileDiffs': true })
  })

  it('does not rewrite a file edited since the last write, and says so', async () => {
    make()
    await sync.open()
    const edit = JSON.stringify({ settings: { theme: 'light' } })
    // Saved, but the debounced apply has not run yet.
    userWrite(edit)
    store.db.settings.theme = 'translucent'
    await sync.writeIfUnedited()
    expect(readFileSync(file(), 'utf8')).toBe(edit)
    expect(statuses.at(-1)?.writeSkipped).toBe(true)

    // Once applied, the next change writes again and clears the notice.
    await sync.applyFile()
    store.db.settings.notificationsEnabled = 'false'
    await sync.writeIfUnedited()
    expect(readJson().settings).toEqual({ theme: 'light', notificationsEnabled: false })
    expect(statuses.at(-1)?.writeSkipped).toBe(false)
  })

  it('a deleted file resets nothing and is not recreated by a UI change', async () => {
    make({ settings: { theme: 'light' }, projects: {}, keyboard: {} })
    await sync.open()
    unlinkSync(file())
    await sync.applyFile()
    expect(store.applied).toEqual([])
    sync.onDbChanged()
    await sync.flush()
    expect(existsSync(file())).toBe(false)
  })

  it('resume picks up an existing file as it is, without writing it', async () => {
    writeFileSync(file(), '{"settings":{"theme":"light"}}')
    const before = statSync(file()).mtimeMs
    make()
    await sync.resume()
    expect(statSync(file()).mtimeMs).toBe(before)
    expect(store.applied).toEqual([])
    store.db.settings.theme = 'system'
    sync.onDbChanged()
    await sync.flush()
    expect(readJson().settings).toEqual({ theme: 'system' })
  })

  it('debounces a burst of watcher events into one apply', async () => {
    make()
    await sync.open()
    userWrite(JSON.stringify({ settings: { theme: 'light' } }))
    sync.onFileEvent()
    sync.onFileEvent()
    sync.onFileEvent()
    await sync.flush()
    expect(store.applied).toHaveLength(1)
  })
})

describe('SettingsFileSync open', () => {
  it('applies a save still waiting for its debounce before rewriting the file', async () => {
    make()
    await sync.open()
    userWrite(JSON.stringify({ settings: { theme: 'light' } }))
    await sync.open()
    expect(store.db.settings).toEqual({ theme: 'light' })
    expect(readJson().settings).toEqual({ theme: 'light' })
  })
})
