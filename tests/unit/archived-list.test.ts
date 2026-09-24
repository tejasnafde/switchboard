import { describe, it, expect } from 'vitest'
import {
  ARCHIVED_PAGE_SIZE,
  matchesArchivedQuery,
  selectArchivedPage,
  type ArchivedRow,
} from '../../src/renderer/components/settings/archived-list'

const row = (id: string, title: string, project_path = '/Users/dev/code/acme-console'): ArchivedRow =>
  ({ id, title, project_path, updated_at: 1 })

/** n rows named "chat 1".."chat n", in the order the DB returns them. */
const rows = (n: number): ArchivedRow[] =>
  Array.from({ length: n }, (_, i) => row(`c${i + 1}`, `chat ${i + 1}`))

describe('matchesArchivedQuery', () => {
  const target = row('c1', 'Debug auth callback', '/Users/dev/code/acme-console')

  it('matches an empty or whitespace-only query', () => {
    expect(matchesArchivedQuery(target, '')).toBe(true)
    expect(matchesArchivedQuery(target, '   ')).toBe(true)
  })

  it('matches the title regardless of case', () => {
    expect(matchesArchivedQuery(target, 'AUTH')).toBe(true)
    expect(matchesArchivedQuery(target, 'debug auth')).toBe(true)
  })

  it('matches the project path, which the row also shows', () => {
    expect(matchesArchivedQuery(target, 'acme-console')).toBe(true)
  })

  it('requires every term, across title and path together', () => {
    expect(matchesArchivedQuery(target, 'auth acme')).toBe(true)
    expect(matchesArchivedQuery(target, 'auth notes-cli')).toBe(false)
  })

  it('rejects a non-match', () => {
    expect(matchesArchivedQuery(target, 'kanban')).toBe(false)
  })

  it('survives a null title or path without throwing', () => {
    const broken = { id: 'x', title: null, project_path: null, updated_at: 1 } as unknown as ArchivedRow
    expect(matchesArchivedQuery(broken, 'anything')).toBe(false)
    expect(matchesArchivedQuery(broken, '')).toBe(true)
  })
})

describe('selectArchivedPage', () => {
  it('returns the first page and reports the range', () => {
    const page = selectArchivedPage(rows(25), '', 1, 10)
    expect(page.items.map((r) => r.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'])
    expect(page).toMatchObject({ page: 1, pageCount: 3, total: 25, from: 1, to: 10 })
  })

  it('returns a short final page with the correct range', () => {
    const page = selectArchivedPage(rows(25), '', 3, 10)
    expect(page.items.map((r) => r.id)).toEqual(['c21', 'c22', 'c23', 'c24', 'c25'])
    expect(page).toMatchObject({ page: 3, pageCount: 3, from: 21, to: 25 })
  })

  it('preserves the order it was given, so newest-first survives paging', () => {
    const input = [row('new', 'newest'), row('mid', 'middle'), row('old', 'oldest')]
    expect(selectArchivedPage(input, '', 1, 2).items.map((r) => r.id)).toEqual(['new', 'mid'])
  })

  it('clamps a page past the end instead of rendering nothing', () => {
    // The regression: unarchiving the last row of the last page removes that
    // page, and the caller still holds the old number.
    const page = selectArchivedPage(rows(11), '', 99, 10)
    expect(page.page).toBe(2)
    expect(page.items.map((r) => r.id)).toEqual(['c11'])
  })

  it('clamps a page below one', () => {
    expect(selectArchivedPage(rows(5), '', 0, 10).page).toBe(1)
    expect(selectArchivedPage(rows(5), '', -3, 10).page).toBe(1)
  })

  it('clamps when a query shrinks the result under the current page', () => {
    const page = selectArchivedPage(rows(25), 'chat 1', 3, 10)
    // "1" is a substring test, so it matches 1, 10-19 AND 21: 12 rows, 2 pages.
    expect(page).toMatchObject({ total: 12, pageCount: 2, page: 2 })
    expect(page.items.map((r) => r.id)).toEqual(['c19', 'c21'])
  })

  it('reports one empty page when nothing matches', () => {
    const page = selectArchivedPage(rows(25), 'nothing here', 2, 10)
    expect(page).toMatchObject({ items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 })
  })

  it('handles an empty list', () => {
    expect(selectArchivedPage([], '', 1, 10)).toMatchObject({
      items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0,
    })
  })

  it('ignores surrounding whitespace in the query', () => {
    expect(selectArchivedPage(rows(3), '  chat 2  ', 1, 10).items.map((r) => r.id)).toEqual(['c2'])
  })

  it('defaults to the shared page size', () => {
    const page = selectArchivedPage(rows(ARCHIVED_PAGE_SIZE + 1), '', 1)
    expect(page.items).toHaveLength(ARCHIVED_PAGE_SIZE)
    expect(page.pageCount).toBe(2)
  })
})
