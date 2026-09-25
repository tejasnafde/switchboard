import { describe, expect, it } from 'vitest'
import {
  SETTINGS_PAGES,
  SETTING_ROWS,
  changedCountByPage,
  isSettingChanged,
  searchSettingRows,
} from '../../src/renderer/components/settings/settings-rows'

describe('settings rows', () => {
  it('gives every row a unique id on a known page', () => {
    const ids = SETTING_ROWS.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    const pages = new Set(SETTINGS_PAGES.map((page) => page.id))
    for (const row of SETTING_ROWS) expect(pages.has(row.page), row.id).toBe(true)
  })

  it('has the nine pages in navigation order', () => {
    expect(SETTINGS_PAGES.map((page) => page.title)).toEqual([
      'General', 'Appearance', 'Chat & agents', 'Accounts & models', 'Projects',
      'Keyboard', 'Devices & machines', 'Archive & data', 'About',
    ])
  })
})

describe('searchSettingRows', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSettingRows('  ')).toEqual([])
  })

  it('matches label, description, page title and keys, every term required', () => {
    expect(searchSettingRows('steer').map((r) => r.id)).toEqual(['chat.followUp'])
    expect(searchSettingRows('vibrancy').map((r) => r.id)).toEqual([])
    expect(searchSettingRows('macos light').map((r) => r.id)).toEqual(['appearance.theme'])
    expect(searchSettingRows('keyboard ⌘J').map((r) => r.label)).toEqual(['Toggle terminal'])
    expect(searchSettingRows('THEME').some((r) => r.id === 'appearance.theme')).toBe(true)
    expect(searchSettingRows('google').map((r) => r.id)).toEqual(['devices.mobile'])
  })

  it('lists results in page order', () => {
    const pages = SETTINGS_PAGES.map((p) => p.id)
    const order = searchSettingRows('e').map((r) => pages.indexOf(r.page))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe('changed settings', () => {
  it('counts only loaded values that differ from the default, per page', () => {
    const values = {
      'chat.followUp': 'queue',
      'chat.streaming': 'true',
      'chat.fileDiffs': 'true',
      'appearance.theme': 'dark',
      'accounts.instances': 'anything',
    }
    const counts = changedCountByPage(values)
    expect(counts.chat).toBe(2)
    expect(counts.appearance).toBe(0)
    expect(counts.accounts).toBe(0)
    expect(Object.keys(counts)).toHaveLength(9)
  })

  it('does not mark a row whose value has not loaded', () => {
    const row = SETTING_ROWS.find((r) => r.id === 'chat.followUp')!
    expect(isSettingChanged(row, {})).toBe(false)
  })
})
