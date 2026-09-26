import { describe, expect, it } from 'vitest'
import { filterComboboxOptions, groupComboboxOptions, type ComboboxOption } from '../../src/renderer/components/ui/combobox-options'

const options: ComboboxOption[] = [
  { value: '/p/switchboard', label: 'switchboard', group: 'Recent', keywords: ['/p/switchboard'] },
  { value: '/p/ssg-api', label: 'ssg-api', group: 'SSG', hint: 'work' },
  { value: '/p/scout', label: 'Scout', group: 'Recent' },
]

describe('filterComboboxOptions', () => {
  it('returns every option for an empty or blank query', () => {
    expect(filterComboboxOptions(options, '')).toBe(options)
    expect(filterComboboxOptions(options, '   ')).toBe(options)
  })

  it('matches the label case-insensitively and keeps the given order', () => {
    expect(filterComboboxOptions(options, 'S').map((o) => o.value)).toEqual(['/p/switchboard', '/p/ssg-api', '/p/scout'])
    expect(filterComboboxOptions(options, 'scOUT').map((o) => o.value)).toEqual(['/p/scout'])
  })

  it('matches the hint and keywords too', () => {
    expect(filterComboboxOptions(options, 'work').map((o) => o.value)).toEqual(['/p/ssg-api'])
    expect(filterComboboxOptions(options, '/p/sw').map((o) => o.value)).toEqual(['/p/switchboard'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterComboboxOptions(options, 'zzz')).toEqual([])
  })
})

describe('groupComboboxOptions', () => {
  it('puts each group where it first appears and gathers its options', () => {
    const groups = groupComboboxOptions(options)
    expect(groups.map((g) => g.heading)).toEqual(['Recent', 'SSG'])
    expect(groups[0].options.map((o) => o.value)).toEqual(['/p/switchboard', '/p/scout'])
  })

  it('keeps ungrouped options under an undefined heading', () => {
    expect(groupComboboxOptions([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }])).toEqual([
      { heading: undefined, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    ])
  })
})
