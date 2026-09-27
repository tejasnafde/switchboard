import { describe, expect, it } from 'vitest'
import {
  FILE_SETTINGS,
  describeSkipped,
  fileSetting,
  isSettingsFileKey,
  planSettingsFileApply,
  projectSettingsFile,
  serializeSettingsFile,
  settingsFileBanner,
  settingsFileSchema,
  IDLE_SETTINGS_FILE_STATUS,
  type SettingsSnapshot,
} from '@shared/settings-file'
import { SETTING_ROW, SETTING_ROWS } from '../../src/renderer/components/settings/settings-rows'
import { RECENT_SESSION_LIMITS } from '../../src/renderer/components/sidebar/recent-session-limit'
import { SCOPABLE_SETTINGS } from '@shared/project-settings'

const EMPTY: SettingsSnapshot = { settings: {}, projects: {}, keyboard: {} }
const opts = { projectKey: (p: string) => p.replace(/\/+$/, ''), platform: 'mac' as const }
const plan = (text: unknown, current: SettingsSnapshot = EMPTY) => {
  const result = planSettingsFileApply(typeof text === 'string' ? text : JSON.stringify(text), current, opts)
  if (!result.ok) throw new Error(result.error)
  return result
}

// Row id -> the settings key its binding in setting-values.ts writes.
const ROW_KEYS: Record<string, string> = {
  [SETTING_ROW.notifyTurnEnd.id]: 'notificationsEnabled',
  [SETTING_ROW.recentLimit.id]: 'sidebar.recentSessionLimit',
  [SETTING_ROW.ideIdleTtl.id]: 'ide.idleTtlMinutes',
  [SETTING_ROW.analytics.id]: 'analytics.enabled',
  [SETTING_ROW.theme.id]: 'theme',
  [SETTING_ROW.followUp.id]: 'chat.followUpDefault',
  [SETTING_ROW.streaming.id]: 'assistantStreamingEnabled',
  [SETTING_ROW.envMode.id]: 'defaultSessionEnvMode',
  [SETTING_ROW.runtimeMode.id]: 'chat.defaultRuntimeMode',
  [SETTING_ROW.fileDiffs.id]: 'chat.showFileDiffs',
  [SETTING_ROW.tourAutoplay.id]: 'tour.autoplay',
}

describe('settings.json allow-list', () => {
  it('holds exactly the value rows of the Settings page, with their defaults', () => {
    const valueRows = SETTING_ROWS.filter((r) => r.defaultValue !== undefined && r.page !== 'keyboard')
    expect(valueRows.map((r) => r.id).sort()).toEqual(Object.keys(ROW_KEYS).sort())
    expect(FILE_SETTINGS.map((s) => s.key).sort()).toEqual(Object.values(ROW_KEYS).sort())
    for (const row of valueRows) expect(fileSetting(ROW_KEYS[row.id])!.defaultValue, row.id).toBe(row.defaultValue)
  })

  it('offers the same choices as the rows', () => {
    for (const row of SETTING_ROWS.filter((r) => r.options)) {
      expect([...fileSetting(ROW_KEYS[row.id])!.choices!].sort(), row.id).toEqual(row.options!.map((o) => o.value).sort())
    }
    expect(fileSetting('sidebar.recentSessionLimit')!.choices).toEqual([...RECENT_SESSION_LIMITS])
  })

  it('covers every scopable setting', () => {
    for (const s of SCOPABLE_SETTINGS) expect(fileSetting(s.key)?.defaultValue).toBe(s.defaultValue)
  })

  it('recognises the stored keys a write to should rewrite the file', () => {
    expect(isSettingsFileKey('theme')).toBe(true)
    expect(isSettingsFileKey('keyboard.overrides')).toBe(true)
    expect(isSettingsFileKey('project:/repo:chat.defaultRuntimeMode')).toBe(true)
    expect(isSettingsFileKey('project:/repo:somethingElse')).toBe(false)
    expect(isSettingsFileKey('mobile.pairingToken')).toBe(false)
    expect(isSettingsFileKey('layout.rightPaneMode')).toBe(false)
  })
})

describe('projectSettingsFile', () => {
  it('leaves defaults and values the setting does not accept out', () => {
    const file = projectSettingsFile({
      ...EMPTY,
      settings: { theme: 'dark', 'chat.followUpDefault': 'queue', notificationsEnabled: 'false', 'sidebar.recentSessionLimit': '7', 'ide.idleTtlMinutes': '12' },
    }, { platform: 'mac' })
    expect(file.settings).toEqual({ 'chat.followUpDefault': 'queue', notificationsEnabled: false, 'ide.idleTtlMinutes': 12 })
    expect(file.$schema).toBe('./settings.schema.json')
  })

  it('never carries anything off the allow-list, whatever the snapshot holds', () => {
    const file = projectSettingsFile({
      settings: { theme: 'light', 'mobile.pairingToken': 'secret', 'provider.env': 'API_KEY=x', 'window.bounds': '{}' },
      projects: { '/repo': { 'chat.defaultRuntimeMode': 'plan', 'mobile.token': 'secret' } },
      keyboard: { 'app.search': ['Mod+Shift+Y'], 'future.command': ['Mod+Shift+U'] },
    }, { platform: 'mac' })
    const text = serializeSettingsFile(file)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('API_KEY')
    expect(text).not.toContain('window.bounds')
    expect(file.projects).toEqual({ '/repo': { 'chat.defaultRuntimeMode': 'plan' } })
    // Another build's rebind stays in the DB, not the file.
    expect(file.keyboard).toEqual({ 'app.search': ['Mod+Shift+Y'] })
  })

  it('keeps a project override equal to the global default, since it pins the project', () => {
    const file = projectSettingsFile({ ...EMPTY, projects: { '/repo': { 'chat.defaultRuntimeMode': 'sandbox' } } })
    expect(file.projects['/repo']).toEqual({ 'chat.defaultRuntimeMode': 'sandbox' })
  })

  it('spells a project as the project list does', () => {
    const file = projectSettingsFile({ ...EMPTY, projects: { '/real/repo': { defaultSessionEnvMode: 'worktree' } } }, {
      projectLabel: (key) => (key === '/real/repo' ? '/link/repo' : key),
    })
    expect(Object.keys(file.projects)).toEqual(['/link/repo'])
  })
})

describe('planSettingsFileApply', () => {
  it('applies nothing for invalid JSON or a non-object', () => {
    expect(planSettingsFileApply('{ "settings": ', EMPTY, opts)).toMatchObject({ ok: false })
    expect(planSettingsFileApply('', EMPTY, opts)).toMatchObject({ ok: false })
    expect(planSettingsFileApply('[1]', EMPTY, opts)).toEqual({ ok: false, error: 'the file must hold one JSON object' })
  })

  it('writes typed values in their stored form', () => {
    const result = plan({ settings: { theme: 'light', notificationsEnabled: false, 'sidebar.recentSessionLimit': 8 } })
    expect(result.ops).toEqual([
      { kind: 'set', key: 'theme', value: 'light' },
      { kind: 'set', key: 'notificationsEnabled', value: 'false' },
      { kind: 'set', key: 'sidebar.recentSessionLimit', value: '8' },
    ])
    expect(result.skipped).toEqual([])
  })

  it('skips an unknown key and a bad value, and leaves those settings alone', () => {
    const current = { ...EMPTY, settings: { theme: 'light' } }
    const result = plan({ settings: { theme: 'purple', 'mobile.pairingToken': 'x', notificationsEnabled: 'no' }, extra: 1 }, current)
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([
      { entry: 'extra', reason: 'not a section of this file' },
      { entry: 'settings.theme', reason: 'expected one of "dark", "light", "translucent", "system"' },
      { entry: 'settings.mobile.pairingToken', reason: 'not a setting this file can change' },
      { entry: 'settings.notificationsEnabled', reason: 'expected true or false' },
    ])
  })

  it('resets a key removed from the file, and only when it was changed', () => {
    const current = { ...EMPTY, settings: { theme: 'light', notificationsEnabled: 'true', 'chat.followUpDefault': 'bogus' } }
    expect(plan({ settings: {} }, current).ops).toEqual([{ kind: 'remove', key: 'theme' }])
  })

  it('writes nothing for the file it would itself write', () => {
    const current: SettingsSnapshot = {
      settings: { theme: 'light', 'ide.idleTtlMinutes': '2.5' },
      projects: { '/repo': { 'chat.defaultRuntimeMode': 'plan' } },
      keyboard: { 'app.search': ['Mod+Shift+Y'] },
    }
    const text = serializeSettingsFile(projectSettingsFile(current, { platform: 'mac' }))
    expect(plan(text, current)).toEqual({ ok: true, ops: [], skipped: [] })
  })

  it('refuses a section that is not an object without resetting it', () => {
    const current = { ...EMPTY, settings: { theme: 'light' } }
    const result = plan({ settings: ['theme'] }, current)
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ entry: 'settings', reason: 'expected an object' }])
  })

  describe('projects', () => {
    it('sets, compares by project key, and removes overrides gone from the file', () => {
      const current = { ...EMPTY, projects: { '/a': { 'chat.defaultRuntimeMode': 'plan', defaultSessionEnvMode: 'worktree' } } }
      const result = plan({ projects: { '/a/': { 'chat.defaultRuntimeMode': 'plan' }, '/b': { 'chat.showFileDiffs': true } } }, current)
      expect(result.ops).toEqual([
        { kind: 'project-set', projectPath: '/b', key: 'chat.showFileDiffs', value: 'true' },
        { kind: 'project-remove', projectKey: '/a', key: 'defaultSessionEnvMode' },
      ])
    })

    it('refuses a setting a project cannot override, and a bad value', () => {
      const current = { ...EMPTY, projects: { '/a': { 'chat.defaultRuntimeMode': 'plan' } } }
      const result = plan({ projects: { '/a': { theme: 'light', 'chat.defaultRuntimeMode': 'yolo' } } }, current)
      expect(result.ops).toEqual([])
      expect(result.skipped.map((s) => s.entry)).toEqual(['projects./a.theme', 'projects./a.chat.defaultRuntimeMode'])
    })

    it('leaves a project alone when its entry is not an object', () => {
      const current = { ...EMPTY, projects: { '/a': { 'chat.defaultRuntimeMode': 'plan' } } }
      expect(plan({ projects: { '/a': 'plan' } }, current).ops).toEqual([])
    })
  })

  describe('keyboard', () => {
    const keyboardOp = (result: ReturnType<typeof plan>) => {
      const op = result.ops.find((o) => o.kind === 'keyboard')
      return op && op.kind === 'keyboard' ? JSON.parse(op.value) : undefined
    }

    it('writes a valid rebind', () => {
      expect(keyboardOp(plan({ keyboard: { 'app.search': ['Mod+Shift+Y'] } }))).toEqual({ 'app.search': ['Mod+Shift+Y'] })
    })

    it('refuses a reserved key, a typing key, an unknown id and a fixed command', () => {
      const result = plan({
        keyboard: {
          'app.search': ['Mod+Q'],
          'app.command-palette': ['A'],
          'no.such.command': ['Mod+Shift+Y'],
          'app.toggle-sidebar': 'Mod+B',
        },
      })
      expect(result.ops).toEqual([])
      const reasons = Object.fromEntries(result.skipped.map((s) => [s.entry, s.reason]))
      expect(reasons['keyboard.app.search']).toMatch(/^"Mod\+Q": /)
      expect(reasons['keyboard.app.command-palette']).toMatch(/Add a modifier/)
      expect(reasons['keyboard.no.such.command']).toBe('not a command in this version of Switchboard')
      expect(reasons['keyboard.app.toggle-sidebar']).toBe('expected a list of keys, like ["Mod+Shift+P"]')
    })

    it('refuses a clash, naming the command it clashes with, and keeps the stored rebind', () => {
      const current = { ...EMPTY, keyboard: { 'app.search': ['Mod+Shift+Y'] } }
      const result = plan({ keyboard: { 'app.search': ['Mod+Shift+P'] } }, current)
      expect(result.skipped).toEqual([{ entry: 'keyboard.app.search', reason: '"Mod+Shift+P" is already Command palette' }])
      expect(result.ops).toEqual([])
    })

    it('resets a removed rebind, and keeps another build\'s', () => {
      const current = { ...EMPTY, keyboard: { 'app.search': ['Mod+Shift+Y'], 'future.command': ['Mod+Shift+U'] } }
      expect(keyboardOp(plan({ keyboard: {} }, current))).toEqual({ 'future.command': ['Mod+Shift+U'] })
    })

    it('accepts a swap that only works once both apply', () => {
      const swap = { 'app.search': ['Mod+Shift+P'], 'app.command-palette': ['Mod+Shift+F'] }
      expect(keyboardOp(plan({ keyboard: swap }))).toEqual(swap)
    })
  })
})

describe('banner and schema', () => {
  it('names what was skipped, the parse error first, and a skipped write', () => {
    expect(settingsFileBanner(IDLE_SETTINGS_FILE_STATUS)).toBeNull()
    const skipped = [
      { entry: 'settings.theme', reason: 'expected one of' },
      { entry: 'keyboard.x', reason: 'unknown' },
      { entry: 'keyboard.y', reason: 'unknown' },
    ]
    expect(describeSkipped(skipped)).toBe('settings.theme (expected one of); keyboard.x (unknown); and 1 more')
    expect(settingsFileBanner({ ...IDLE_SETTINGS_FILE_STATUS, parseError: 'not valid JSON', skipped }))
      .toBe('settings.json was not applied: not valid JSON. Fix it and save again.')
    expect(settingsFileBanner({ ...IDLE_SETTINGS_FILE_STATUS, writeSkipped: true })).toMatch(/was not written to settings.json/)
    expect(settingsFileBanner({ ...IDLE_SETTINGS_FILE_STATUS, writeFailed: true })).toMatch(/could not be written to settings.json/)
  })

  it('describes every allow-listed setting and rebindable command', () => {
    const schema = settingsFileSchema('mac') as { properties: Record<string, { properties?: Record<string, unknown>; additionalProperties?: { properties: Record<string, unknown> } }> }
    expect(Object.keys(schema.properties.settings.properties!).sort()).toEqual(FILE_SETTINGS.map((s) => s.key).sort())
    expect(schema.properties.settings.properties!.theme).toMatchObject({ enum: ['dark', 'light', 'translucent', 'system'] })
    expect(schema.properties.settings.properties!.notificationsEnabled).toMatchObject({ type: 'boolean' })
    expect(Object.keys(schema.properties.projects.additionalProperties!.properties).sort())
      .toEqual(SCOPABLE_SETTINGS.map((s) => s.key).sort())
    expect(schema.properties.keyboard.properties).toHaveProperty('app.search')
    expect(schema.properties.keyboard.properties).not.toHaveProperty('app.focus-window')
  })
})

describe('settingsJsonOpenTarget', () => {
  it('uses the embedded IDE only for a local chat with a folder', async () => {
    const { settingsJsonOpenTarget } = await import('../../src/renderer/components/settings/settings-json-open')
    expect(settingsJsonOpenTarget({ projectPath: '/repo' })).toBe('ide')
    expect(settingsJsonOpenTarget({ projectPath: '/repo', worktreePath: '/wt' })).toBe('ide')
    expect(settingsJsonOpenTarget({ projectPath: '/repo', machineId: 'vm-1' })).toBe('system')
    expect(settingsJsonOpenTarget({})).toBe('system')
    expect(settingsJsonOpenTarget(null)).toBe('system')
  })
})
