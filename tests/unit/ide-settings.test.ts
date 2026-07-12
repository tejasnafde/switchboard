/**
 * Theme + defaults coupling between Switchboard and the embedded workbench.
 * The workbench live-applies changes to its User/settings.json, so this is
 * the whole integration surface: map our theme to a colorTheme and merge
 * managed keys without clobbering the user's own workbench settings.
 */
import { describe, it, expect } from 'vitest'
import { themeToColorTheme, mergeUserSettings, SEEDED_DEFAULTS } from '../../src/main/ide/settings'

describe('themeToColorTheme', () => {
  it('maps dark and translucent to the dark theme, light to light', () => {
    expect(themeToColorTheme('dark')).toBe('Switchboard Charcoal')
    expect(themeToColorTheme('translucent')).toBe('Switchboard Charcoal')
    expect(themeToColorTheme('light')).toBe('Default Light Modern')
  })

  it('falls back to dark for unknown values', () => {
    expect(themeToColorTheme('system')).toBe('Switchboard Charcoal')
  })
})

describe('mergeUserSettings', () => {
  it('seeds defaults plus the patch when no settings file exists', () => {
    const out = JSON.parse(mergeUserSettings(null, { 'workbench.colorTheme': 'Default Light Modern' })!)
    expect(out['files.autoSave']).toBe(SEEDED_DEFAULTS['files.autoSave'])
    expect(out['workbench.colorTheme']).toBe('Default Light Modern')
  })

  it('user-set keys always win, but ABSENT defaults backfill - new suppressions reach existing installs', () => {
    const existing = JSON.stringify({ 'files.autoSave': 'off', 'editor.fontSize': 18 })
    const out = JSON.parse(mergeUserSettings(existing, { 'workbench.colorTheme': 'Switchboard Charcoal' })!)
    expect(out['files.autoSave']).toBe('off') // user turned it off, stays off
    expect(out['editor.fontSize']).toBe(18)
    expect(out['workbench.colorTheme']).toBe('Switchboard Charcoal')
    // seeded key the user never touched arrives even on an existing file
    expect(out['workbench.secondarySideBar.defaultVisibility']).toBe('hidden')
  })

  it('returns null (do not write) when the existing file is unparseable - VS Code settings are JSONC and users hand-edit comments in; clobbering them with defaults is data loss', () => {
    expect(mergeUserSettings('// work laptop\n{ "editor.fontSize": 18 }', { 'workbench.colorTheme': 'Default Dark Modern' })).toBeNull()
    expect(mergeUserSettings('{nope', {})).toBeNull()
  })
})
