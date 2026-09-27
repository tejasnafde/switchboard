import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A rename that fails the way Windows does while the target is open, and can edit the target meanwhile.
const hook = vi.hoisted(() => ({ onRename: null as null | ((from: string, to: string) => void) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      hook.onRename?.(from, to)
      return actual.rename(from, to)
    },
  }
})
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { SettingsFileSync } = await import('../../src/main/settings-file')
const { writeFileSafe } = await import('../../src/main/files/writing')

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

/** Fails every rename; the first one also saves `edit` into the target, as an editor would. */
function lockedWhileEdited(target: string, edit: string) {
  let edited = false
  hook.onRename = () => {
    if (!edited) {
      edited = true
      writeFileSync(target, edit)
    }
    throw eperm()
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-replace-callers-test-')) })
afterEach(() => {
  hook.onRename = null
  rmSync(dir, { recursive: true, force: true })
})

describe('a replacement waiting on a Windows lock', () => {
  it('settings.json: an edit saved meanwhile is kept and reported as unapplied', async () => {
    const db = { settings: {} as Record<string, string>, projects: {}, keyboard: {} }
    let savedHash: string | null = null
    const statuses: { writeSkipped: boolean }[] = []
    const sync = new SettingsFileSync({
      dir,
      readSnapshot: () => structuredClone(db),
      projectLabel: (key) => key,
      projectKey: (path) => path,
      applyOps: () => [],
      onStatus: (status) => statuses.push(status),
      syncedHash: { load: () => savedHash, save: (hash) => { savedHash = hash } },
      log: { info: vi.fn(), warn: vi.fn() },
      debounceMs: 60_000,
    })
    await sync.open()
    const file = join(dir, 'settings.json')
    const edit = JSON.stringify({ settings: { theme: 'light' } })
    lockedWhileEdited(file, edit)
    db.settings.theme = 'translucent'
    await sync.writeIfUnedited()
    sync.dispose()
    expect(readFileSync(file, 'utf8')).toBe(edit)
    expect(statuses.at(-1)?.writeSkipped).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.schema.json'])
  })

  it('writeFileSafe: an edit saved meanwhile is a conflict, not overwritten', async () => {
    const file = join(dir, 'a.ts')
    writeFileSync(file, 'old\n')
    lockedWhileEdited(file, 'edited\n')
    const result = await writeFileSafe(file, 'new\n', { expectedContent: 'old\n' })
    expect(result).toEqual({ ok: false, error: 'File changed on disk after the diff was captured', conflict: true })
    expect(readFileSync(file, 'utf8')).toBe('edited\n')
    expect(readdirSync(dir)).toEqual(['a.ts'])
  })

  it('writeFileSafe: a file deleted meanwhile is a conflict, not recreated', async () => {
    const file = join(dir, 'a.ts')
    writeFileSync(file, 'old\n')
    const { mtimeMs } = statSync(file)
    let deleted = false
    hook.onRename = () => {
      if (!deleted) {
        deleted = true
        unlinkSync(file)
      }
      throw eperm()
    }
    const result = await writeFileSafe(file, 'new\n', { expectedMtimeMs: mtimeMs })
    expect(result).toEqual({ ok: false, error: 'File changed on disk since open', conflict: true })
    expect(readdirSync(dir)).toEqual([])
  })

  it('writeFileSafe: an unchanged file is still written once the lock clears', async () => {
    const file = join(dir, 'a.ts')
    writeFileSync(file, 'old\n')
    let failures = 2
    hook.onRename = () => { if (failures-- > 0) throw eperm() }
    const result = await writeFileSafe(file, 'new\n', { expectedContent: 'old\n' })
    expect(result.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('new\n')
  })
})
