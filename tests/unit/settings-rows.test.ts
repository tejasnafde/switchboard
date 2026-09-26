import { describe, expect, it } from 'vitest'
import {
  SETTINGS_PAGES,
  SETTING_ROWS,
  shortcutRows,
  changedCountByPage,
  defaultValueLabel,
  isSettingChanged,
  searchSettingRows,
} from '../../src/renderer/components/settings/settings-rows'
import { formatBinding, setActiveShortcutOverrides, shortcutsFor } from '../../src/shared/shortcuts'

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
    expect(searchSettingRows('steer').map((r) => r.id)).toEqual(['chat.followUp', 'keyboard.composer.send-other'])
    expect(searchSettingRows('vibrancy').map((r) => r.id)).toEqual([])
    expect(searchSettingRows('macos light').map((r) => r.id)).toEqual(['appearance.theme'])
    expect(searchSettingRows('keyboard toggle terminal').map((r) => r.id)).toEqual(['keyboard.app.toggle-terminal'])
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

describe('shortcut rows', () => {
  it('lists every registry command for the platform with its keys', () => {
    const mac = shortcutRows('mac')
    const other = shortcutRows('other')
    expect(mac.length).toBe(shortcutsFor('mac').length)
    expect(other.length).toBe(shortcutsFor('other').length)
    const terminal = (rows: typeof mac) => rows.find((r) => r.id === 'keyboard.app.toggle-terminal')!
    expect(terminal(mac)).toMatchObject({ page: 'keyboard', section: 'Panels', keys: '⌘J' })
    expect(terminal(other).keys).toBe('Ctrl+J')
  })

  it('indexes them for search, so keys are searchable', () => {
    const keys = shortcutRows()[0].keys!
    expect(searchSettingRows(keys).some((r) => r.page === 'keyboard')).toBe(true)
  })

  it('search finds the key in effect, not the default, once rebound', () => {
    setActiveShortcutOverrides(JSON.stringify({ 'app.toggle-terminal': ['Mod+Alt+Shift+F9'] }))
    try {
      const label = formatBinding('Mod+Alt+Shift+F9')
      expect(searchSettingRows(label).map((r) => r.id)).toEqual(['keyboard.app.toggle-terminal'])
    } finally {
      setActiveShortcutOverrides(null)
    }
  })

  it('gives rebindable rows a value to mark as changed, and fixed rows none', () => {
    const rows = shortcutRows('mac')
    const row = (id: string) => rows.find((r) => r.command === id)!
    expect(row('chat.interrupt')).toMatchObject({ defaultValue: 'Mod+Backspace', defaultLabel: '⌘⌫' })
    expect(row('app.toggle-sidebar').defaultValue).toBe('Mod+B Mod+Shift+B')
    expect(row('composer.send').defaultValue).toBeUndefined()
    expect(isSettingChanged(row('chat.interrupt'), { 'keyboard.chat.interrupt': 'Mod+.' })).toBe(true)
    expect(isSettingChanged(row('chat.interrupt'), { 'keyboard.chat.interrupt': '' })).toBe(true)
    expect(changedCountByPage({ 'keyboard.chat.interrupt': 'Mod+.' }).keyboard).toBe(1)
  })
})

describe('defaultValueLabel', () => {
  const row = (id: string) => SETTING_ROWS.find((r) => r.id === id)!
  it('names the default the way the control shows it', () => {
    expect(defaultValueLabel(row('appearance.theme'))).toBe('Dark')
    expect(defaultValueLabel(row('chat.streaming'))).toBe('On')
    expect(defaultValueLabel(row('chat.fileDiffs'))).toBe('Off')
    expect(defaultValueLabel(row('sidebar.recentLimit'))).toBe('4 conversations')
  })
})
