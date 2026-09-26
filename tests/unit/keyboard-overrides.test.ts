/**
 * The window, the app menu and the stored value must agree on the shortcut
 * rebinds: the renderer re-reads after a failed write and when main says the
 * value changed, and main applies a value only once it is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let db: string | null
let failWrites = false
let onGet: (() => void) | null = null
// Resolves a write later than the next one, as a slow disk or socket would.
let setDelays: number[] = []
let inFlight = 0
let maxInFlight = 0

async function fresh() {
  vi.resetModules()
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: async () => { onGet?.(); return db },
        set: async (_key: string, value: string) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            await new Promise((r) => setTimeout(r, setDelays.shift() ?? 0))
            if (failWrites) throw new Error('disk full')
            db = value
          } finally {
            inFlight -= 1
          }
        },
      },
    },
  })
  const service = await import('../../src/renderer/services/keyboard-overrides')
  const shortcuts = await import('../../src/shared/shortcuts')
  return { ...service, label: (id: string) => shortcuts.shortcutLabel(id, 'mac') }
}

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  db = null
  failWrites = false
  onGet = null
  setDelays = []
  inFlight = 0
  maxInFlight = 0
})

describe('renderer shortcut overrides', () => {
  it('applies a write at once and keeps ids another build stored', async () => {
    db = JSON.stringify({ 'from.newer-build': ['Mod+Shift+Y'] })
    const s = await fresh()
    await s.setKeyboardOverride('chat.new', ['Mod+Shift+U'])
    expect(s.label('chat.new')).toBe('⌘⇧U')
    expect(JSON.parse(db!)).toEqual({ 'from.newer-build': ['Mod+Shift+Y'], 'chat.new': ['Mod+Shift+U'] })
  })

  it('goes back to the stored value when the write fails', async () => {
    db = JSON.stringify({ 'chat.new': ['Mod+Shift+U'] })
    const s = await fresh()
    await s.loadKeyboardOverrides()
    failWrites = true
    await expect(s.setKeyboardOverride('chat.new', ['Mod+Shift+I'])).rejects.toThrow('disk full')
    expect(s.label('chat.new')).toBe('⌘⇧U')
    // and the next write starts from what is stored, not from the failed one
    failWrites = false
    await s.setKeyboardOverride('app.search', [])
    expect(JSON.parse(db!)).toEqual({ 'chat.new': ['Mod+Shift+U'], 'app.search': [] })
  })

  it('Reset all: row-by-row writes run one at a time, so a slow one cannot land last', async () => {
    db = JSON.stringify({ 'chat.new': ['Mod+Shift+U'], 'app.search': [], 'from.newer-build': ['Mod+Shift+Y'] })
    const s = await fresh()
    await s.loadKeyboardOverrides()
    setDelays = [30, 0]
    // What Reset all does: one write per changed row, fired together.
    await Promise.all([s.setKeyboardOverride('chat.new', null), s.setKeyboardOverride('app.search', null)])
    expect(maxInFlight).toBe(1)
    expect(JSON.parse(db!)).toEqual({ 'from.newer-build': ['Mod+Shift+Y'] })
    expect(s.label('chat.new')).toBe('⌘⇧O')
  })

  it('a failed write does not stop the ones queued after it', async () => {
    const s = await fresh()
    await s.loadKeyboardOverrides()
    failWrites = true
    const first = s.setKeyboardOverride('chat.new', ['Mod+Shift+U'])
    const second = s.setKeyboardOverride('app.search', [])
    await expect(first).rejects.toThrow('disk full')
    failWrites = false
    await second
    expect(JSON.parse(db!)).toEqual({ 'app.search': [] })
  })

  it('adopts a value written elsewhere when told to re-read', async () => {
    const s = await fresh()
    await s.loadKeyboardOverrides()
    db = JSON.stringify({ 'chat.new': ['Mod+Shift+U'] })
    await s.reloadKeyboardOverrides()
    expect(s.label('chat.new')).toBe('⌘⇧U')
  })

  it('refuses a typing key even when the stored value has one', async () => {
    db = JSON.stringify({ 'chat.new': ['Enter'] })
    const s = await fresh()
    await s.loadKeyboardOverrides()
    expect(s.label('chat.new')).toBe('⌘⇧O')
  })

  it('a re-read that raced a write does not undo it', async () => {
    const s = await fresh()
    await s.loadKeyboardOverrides()
    // The write lands while the re-read is in flight, with the old value in hand.
    let write: Promise<void> | null = null
    onGet = () => { onGet = null; write = s.setKeyboardOverride('chat.new', ['Mod+Shift+U']) }
    await s.reloadKeyboardOverrides()
    await write
    expect(s.label('chat.new')).toBe('⌘⇧U')
  })
})

describe('every desktop registration of the app handlers rebuilds the menu', () => {
  it('passes the one deps factory at startup and on window reopen', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const main = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    const calls = [...main.matchAll(/registerAppHandlers\(([^)]*\)?)\)/g)].map((m) => m[1])
    // startup and the macOS reopen path
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const args of calls) expect(args).toMatch(/^\w+, desktopAppHandlerDeps\(\)$/)
    const factory = main.slice(main.indexOf('function desktopAppHandlerDeps'), main.indexOf('// Custom protocol for onboarding'))
    expect(factory).toContain('applyKeyboardOverrides()')
  })
})

describe('main applies overrides only after they are stored', () => {
  it('calls onSettingChanged after a successful write and not after a failed one', async () => {
    vi.resetModules()
    let fail = false
    vi.doMock('../../src/main/db/database', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/main/db/database')>()),
      setSetting: () => { if (fail) throw new Error('locked') },
      removeSetting: () => {},
    }))
    const { registerAppHandlers } = await import('../../src/main/ipc/app')
    const { AppChannels } = await import('../../src/shared/ipc-channels')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const changed: string[] = []
    registerAppHandlers(
      { handle: (c: string, h: (...args: unknown[]) => unknown) => handlers.set(c, h), emit: () => {} } as never,
      { onSettingChanged: (key) => changed.push(key) },
    )
    handlers.get(AppChannels.SETTINGS_SET)!('keyboard.overrides', '{}')
    fail = true
    expect(() => handlers.get(AppChannels.SETTINGS_SET)!('keyboard.overrides', '{"x":[]}')).toThrow('locked')
    handlers.get('settings:remove')!('keyboard.overrides')
    expect(changed).toEqual(['keyboard.overrides', 'keyboard.overrides'])
    vi.doUnmock('../../src/main/db/database')
  })
})
