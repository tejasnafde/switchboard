/** Directory autocomplete for the remote add-project path field. */
import { describe, it, expect } from 'vitest'
import { splitPath, pathCompletions, moveSelection, acceptSuggestion } from '../../src/renderer/components/sidebar/pathComplete'

const entries = [
  { name: 'ubuntu', isDir: true },
  { name: 'gecko', isDir: true },
  { name: 'gadget', isDir: true },
  { name: 'notes.txt', isDir: false },
]

describe('splitPath', () => {
  it('splits into parent dir + partial segment', () => {
    expect(splitPath('/home/ubuntu/ge')).toEqual({ dir: '/home/ubuntu', partial: 'ge' })
  })
  it('a trailing slash means list that dir with no partial', () => {
    expect(splitPath('/home/ubuntu/')).toEqual({ dir: '/home/ubuntu', partial: '' })
  })
  it('handles root', () => {
    expect(splitPath('/')).toEqual({ dir: '/', partial: '' })
  })
})

describe('pathCompletions', () => {
  it('suggests matching directories as full paths, ignoring files (alphabetical)', () => {
    expect(pathCompletions('/home/g', entries)).toEqual(['/home/gadget', '/home/gecko'])
  })
  it('lists all dirs alphabetically when the partial is empty', () => {
    expect(pathCompletions('/home/', entries)).toEqual(['/home/gadget', '/home/gecko', '/home/ubuntu'])
  })
  it('is case-insensitive', () => {
    expect(pathCompletions('/home/GE', entries)).toEqual(['/home/gecko'])
  })
  it('completes under root', () => {
    expect(pathCompletions('/u', entries)).toEqual(['/ubuntu'])
  })
  it('sorts dot-folders last so they do not crowd out visible ones', () => {
    const withDots = [
      { name: '.cache', isDir: true },
      { name: '.config', isDir: true },
      { name: 'projects', isDir: true },
      { name: 'downloads', isDir: true },
    ]
    expect(pathCompletions('/home/', withDots)).toEqual([
      '/home/downloads',
      '/home/projects',
      '/home/.cache',
      '/home/.config',
    ])
  })
  it('still narrows to dot-folders when the user types a leading dot', () => {
    const withDots = [
      { name: '.cache', isDir: true },
      { name: '.config', isDir: true },
      { name: 'projects', isDir: true },
    ]
    expect(pathCompletions('/home/.c', withDots)).toEqual(['/home/.cache', '/home/.config'])
  })
})

describe('moveSelection', () => {
  it('moves forward and wraps past the end', () => {
    expect(moveSelection(0, 1, 3)).toBe(1)
    expect(moveSelection(2, 1, 3)).toBe(0)
  })
  it('moves backward and wraps past the start', () => {
    expect(moveSelection(0, -1, 3)).toBe(2)
  })
  it('starts from "no selection" (-1) moving down lands on the first item', () => {
    expect(moveSelection(-1, 1, 3)).toBe(0)
  })
  it('returns -1 when there are no suggestions', () => {
    expect(moveSelection(0, 1, 0)).toBe(-1)
  })
})

describe('acceptSuggestion', () => {
  it('appends a trailing slash so the user can keep typing the next segment', () => {
    expect(acceptSuggestion('/home/gecko')).toBe('/home/gecko/')
  })
  it('leaves an already-trailing-slash path alone', () => {
    expect(acceptSuggestion('/home/gecko/')).toBe('/home/gecko/')
  })
})
