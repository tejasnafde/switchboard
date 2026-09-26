/**
 * The scopable-settings registry and the one resolution rule every client
 * and the backend share: project override ?? global ?? default.
 */
import { describe, expect, it } from 'vitest'
import {
  SCOPABLE_SETTINGS,
  effectiveSetting,
  governedSettingKey,
  isScopableSetting,
  parseProjectOverrideKey,
  projectOverrideKey,
  resolveSetting,
  type SettingReader,
} from '../../src/shared/project-settings'
import { FOLLOW_UP_DEFAULT_KEY } from '../../src/shared/turn-delivery'
import { SETTING_DEFAULT_RUNTIME_MODE } from '../../src/shared/session-defaults'
import { isSettingWriteAllowed, isSettingsFrameAllowed, PHONE_SCOPES, FULL_SCOPES } from '../../src/shared/device-auth'
import { SETTING_ROWS } from '../../src/renderer/components/settings/settings-rows'

function reader(overrides: Record<string, Record<string, string>>, globals: Record<string, string>): SettingReader {
  return {
    override: (path, key) => overrides[path]?.[key],
    global: (key) => globals[key],
  }
}

describe('SCOPABLE_SETTINGS', () => {
  it('lists each key once, with a default the setting itself accepts', () => {
    const keys = SCOPABLE_SETTINGS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const setting of SCOPABLE_SETTINGS) expect(setting.accepts(setting.defaultValue)).toBe(true)
  })

  it('holds the Chat & agents defaults that vary by project, and no global app setting', () => {
    expect(SCOPABLE_SETTINGS.map((s) => s.key).sort()).toEqual([
      'chat.defaultRuntimeMode',
      'chat.followUpDefault',
      'chat.showFileDiffs',
      'defaultSessionEnvMode',
    ])
    for (const global of ['theme', 'notifications.enabled', 'keyboard.overrides', 'tour.autoplay']) {
      expect(isScopableSetting(global)).toBe(false)
    }
  })

  it('has exactly one Settings row per scopable key, all on Chat & agents', () => {
    for (const setting of SCOPABLE_SETTINGS) {
      const rows = SETTING_ROWS.filter((row) => row.scopeKey === setting.key)
      expect(rows.map((row) => row.page)).toEqual(['chat'])
      // The row's default is the same value the resolver falls back to.
      expect(rows[0].defaultValue).toBe(setting.defaultValue)
    }
    expect(SETTING_ROWS.filter((row) => row.scopeKey).length).toBe(SCOPABLE_SETTINGS.length)
  })
})

describe('effectiveSetting', () => {
  const globals = { [FOLLOW_UP_DEFAULT_KEY]: 'queue' }

  it('prefers the project override, then the global value, then the default', () => {
    const read = reader({ '/repo/a': { [FOLLOW_UP_DEFAULT_KEY]: 'steer' } }, globals)
    expect(resolveSetting(FOLLOW_UP_DEFAULT_KEY, '/repo/a', read)).toEqual({ value: 'steer', source: 'project' })
    expect(resolveSetting(FOLLOW_UP_DEFAULT_KEY, '/repo/b', read)).toEqual({ value: 'queue', source: 'global' })
    expect(resolveSetting(FOLLOW_UP_DEFAULT_KEY, null, read)).toEqual({ value: 'queue', source: 'global' })
    expect(resolveSetting(FOLLOW_UP_DEFAULT_KEY, '/repo/b', reader({}, {}))).toEqual({ value: 'steer', source: 'default' })
  })

  it('skips a value the setting does not accept, so a newer build\'s value falls through', () => {
    const read = reader({ '/repo/a': { [SETTING_DEFAULT_RUNTIME_MODE]: 'yolo' } }, { [SETTING_DEFAULT_RUNTIME_MODE]: 'bogus' })
    expect(effectiveSetting(SETTING_DEFAULT_RUNTIME_MODE, '/repo/a', read)).toBe('sandbox')
  })
})

describe('override keys', () => {
  it('round-trips a key whose project part holds a colon (a Windows drive)', () => {
    const key = projectOverrideKey('c:\\users\\me\\repo', 'chat.showFileDiffs')
    expect(parseProjectOverrideKey(key)).toEqual({ projectKey: 'c:\\users\\me\\repo', settingKey: 'chat.showFileDiffs' })
    expect(governedSettingKey(key)).toBe('chat.showFileDiffs')
  })

  it('leaves other keys alone', () => {
    expect(parseProjectOverrideKey('chat.followUpDefault')).toBeNull()
    expect(parseProjectOverrideKey('project:')).toBeNull()
    expect(governedSettingKey('theme')).toBe('theme')
  })

  it('refuses a phone an override of an admin-only setting, by any route', () => {
    const key = projectOverrideKey('/repo/a', SETTING_DEFAULT_RUNTIME_MODE)
    expect(isSettingWriteAllowed(PHONE_SCOPES, key)).toBe(false)
    expect(isSettingsFrameAllowed(PHONE_SCOPES, 'settings:set', [key, 'full-access'])).toBe(false)
    expect(isSettingsFrameAllowed(PHONE_SCOPES, 'settings:project-override-set', ['/repo/a', SETTING_DEFAULT_RUNTIME_MODE, 'full-access'])).toBe(false)
    expect(isSettingsFrameAllowed(PHONE_SCOPES, 'settings:project-override-remove', ['/repo/a', SETTING_DEFAULT_RUNTIME_MODE])).toBe(false)
    expect(isSettingsFrameAllowed(FULL_SCOPES, 'settings:project-override-set', ['/repo/a', SETTING_DEFAULT_RUNTIME_MODE, 'plan'])).toBe(true)
    expect(isSettingsFrameAllowed(PHONE_SCOPES, 'settings:project-override-set', ['/repo/a', FOLLOW_UP_DEFAULT_KEY, 'queue'])).toBe(true)
  })
})
