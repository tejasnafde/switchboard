/**
 * Search + pagination for Settings > Archived.
 *
 * Pure so the clamping rules can be unit-tested without React. The whole
 * archived list already arrives in one IPC call (`getArchivedConversations`,
 * sorted `updated_at DESC`), so filtering and paging happen here in the
 * renderer. That keeps typing instant and adds no per-page round trip; if the
 * list ever outgrows one payload, this is the seam to move behind the IPC.
 */

export interface ArchivedRow {
  id: string
  project_path: string
  title: string
  updated_at: number
}

export const ARCHIVED_PAGE_SIZE = 10

export interface ArchivedPage {
  /** The rows to render: filtered, then sliced to `page`. */
  items: ArchivedRow[]
  /** 1-based and always inside `[1, pageCount]`, whatever the caller asked for. */
  page: number
  /** At least 1, so an empty result still reads as "1 of 1" rather than "of 0". */
  pageCount: number
  /** Rows surviving the filter, across every page. */
  total: number
  /** 1-based inclusive bounds of `items` within `total`; both 0 when empty. */
  from: number
  to: number
}

/**
 * Case-insensitive match on the title and the project path, which are the two
 * things the row shows. Whitespace splits the query into terms that must ALL
 * match, so "auth acme" finds an "auth callback" chat in acme-console. A
 * single-term query is therefore a plain substring test.
 */
export function matchesArchivedQuery(row: ArchivedRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = `${row.title ?? ''} ${row.project_path ?? ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * Filter by `query`, then return page `page`.
 *
 * `page` is clamped rather than trusted, because the page count shrinks under
 * the caller: typing narrows the list, and unarchiving the last row of the
 * last page removes that page. Both would otherwise render a valid page number
 * as an empty list.
 */
export function selectArchivedPage(
  rows: ArchivedRow[],
  query: string,
  page: number,
  pageSize: number = ARCHIVED_PAGE_SIZE,
): ArchivedPage {
  const matches = query.trim() ? rows.filter((row) => matchesArchivedQuery(row, query)) : rows
  const total = matches.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(Math.floor(page) || 1, 1), pageCount)
  const start = (safePage - 1) * pageSize
  const items = matches.slice(start, start + pageSize)
  return {
    items,
    page: safePage,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + items.length,
  }
}
