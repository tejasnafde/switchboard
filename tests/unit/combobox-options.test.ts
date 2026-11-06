import { describe, expect, it } from 'vitest'
import {
  filterComboboxOptions,
  groupComboboxOptions,
  type ComboboxOption,
} from '../../src/renderer/components/ui/combobox-options'

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
    expect(filterComboboxOptions(options, 'S').map((o) => o.value)).toEqual([
      '/p/switchboard',
      '/p/ssg-api',
      '/p/scout',
    ])
    expect(filterComboboxOptions(options, 'scOUT').map((o) => o.value)).toEqual(['/p/scout'])
  })

  it('matches the hint and keywords too', () => {
    expect(filterComboboxOptions(options, 'work').map((o) => o.value)).toEqual(['/p/ssg-api'])
    expect(filterComboboxOptions(options, '/p/sw').map((o) => o.value)).toEqual(['/p/switchboard'])
  })

  it('lists a name match before rows that match only by path', () => {
    const projects: ComboboxOption[] = [
      { value: '/u/Projects/switchboard', label: 'switchboard', keywords: ['/u/Projects/switchboard'] },
      { value: '/u/Projects/scout', label: 'scout', keywords: ['/u/Projects/scout'] },
      { value: '/u/old-projects-archive', label: 'old-projects-archive', keywords: ['/u/old-projects-archive'] },
      { value: '/u/projects-site', label: 'projects-site', keywords: ['/u/projects-site'] },
      { value: '/u/Projects', label: 'Projects', keywords: ['/u/Projects'] },
    ]
    expect(filterComboboxOptions(projects, 'projects').map((o) => o.value)).toEqual([
      '/u/Projects', // exact name
      '/u/projects-site', // name starts with it
      '/u/old-projects-archive', // name contains it
      '/u/Projects/switchboard', // path only, in the given order
      '/u/Projects/scout',
    ])
  })

  it('ranks exact names, prefixes, word starts, paths, then fuzzy matches', () => {
    const projects: ComboboxOption[] = [
      { value: 'fuzzy', label: 'proj-ect-sync' },
      { value: 'buried', label: 'myprojects' },
      { value: 'path', label: 'switchboard', keywords: ['/u/projects/switchboard'] },
      { value: 'word', label: 'old-projects-archive' },
      { value: 'prefix', label: 'projects-site' },
      { value: 'exact', label: 'Projects' },
    ]
    expect(filterComboboxOptions(projects, ' projects ').map((o) => o.value)).toEqual([
      'exact',
      'prefix',
      'word',
      'buried',
      'path',
      'fuzzy',
    ])
  })

  it('keeps a name substring above path-only matches, regardless of recency', () => {
    expect(
      filterComboboxOptions(
        [
          { value: 'path', label: 'switchboard', keywords: ['/users/tejas/desktop/projects/switchboard'] },
          { value: 'name', label: 'myprojects' },
        ],
        'projects',
      ).map((o) => o.value),
    ).toEqual(['name', 'path'])
  })

  it('does not fuzzy-match a shared path prefix or descriptive hint', () => {
    expect(
      filterComboboxOptions(
        [
          { value: 'path', label: 'switchboard', keywords: ['/users/tejas/desktop/projects/switchboard'] },
          { value: 'hint', label: 'scout', hint: 'users tejas desktop projects' },
        ],
        'uts',
      ),
    ).toEqual([])
  })

  it('ranks the project name independently of its displayed machine suffix', () => {
    const projects: ComboboxOption[] = [
      { value: 'prefix', label: 'projects-site · Mac', searchLabel: 'projects-site' },
      { value: 'exact', label: 'projects · server', searchLabel: 'projects' },
    ]
    expect(filterComboboxOptions(projects, 'projects').map((o) => o.value)).toEqual(['exact', 'prefix'])
    expect(filterComboboxOptions(projects, 'server').map((o) => o.value)).toEqual(['exact'])
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
    expect(
      groupComboboxOptions([
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]),
    ).toEqual([
      {
        heading: undefined,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ])
  })
})
