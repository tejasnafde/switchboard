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
    expect(themeToColorTheme('dark')).toBe('Default Dark Modern')
    expect(themeToColorTheme('translucent')).toBe('Default Dark Modern')
    expect(themeToColorTheme('light')).toBe('Default Light Modern')
  })

  it('falls back to dark for unknown values', () => {
    expect(themeToColorTheme('system')).toBe('Default Dark Modern')
  })
})

describe('mergeUserSettings', () => {
  it('seeds defaults plus the patch when no settings file exists', () => {
    const out = JSON.parse(mergeUserSettings(null, { 'workbench.colorTheme': 'Default Light Modern' }))
    expect(out['files.autoSave']).toBe(SEEDED_DEFAULTS['files.autoSave'])
    expect(out['workbench.colorTheme']).toBe('Default Light Modern')
  })

  it('preserves user-set keys and does NOT re-apply defaults on an existing file', () => {
    const existing = JSON.stringify({ 'files.autoSave': 'off', 'editor.fontSize': 18 })
    const out = JSON.parse(mergeUserSettings(existing, { 'workbench.colorTheme': 'Default Dark Modern' }))
    expect(out['files.autoSave']).toBe('off') // user turned it off, stays off
    expect(out['editor.fontSize']).toBe(18)
    expect(out['workbench.colorTheme']).toBe('Default Dark Modern')
  })

  it('survives malformed existing JSON by starting from defaults', () => {
    const out = JSON.parse(mergeUserSettings('{nope', { 'workbench.colorTheme': 'Default Dark Modern' }))
    expect(out['workbench.colorTheme']).toBe('Default Dark Modern')
    expect(out['files.autoSave']).toBe(SEEDED_DEFAULTS['files.autoSave'])
  })
})
