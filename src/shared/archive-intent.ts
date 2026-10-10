/**
 * A query that names "archive" or "archived" as a word asks for archived chats
 * too. The word itself is a filter, not a search term, so it is dropped from
 * the text that is searched. Shared by every chat search so the rule is one
 * rule (message search today; Go to chat should use the same function).
 */
export interface ArchiveIntent {
  includeArchived: boolean
  /** The query without the archive words, spaces collapsed. */
  query: string
}

const ARCHIVE_WORD = /^archived?$/i

export function parseArchiveIntent(query: string): ArchiveIntent {
  const words = query.split(/\s+/).filter(Boolean)
  const rest = words.filter((word) => !ARCHIVE_WORD.test(word))
  return { includeArchived: rest.length < words.length, query: rest.join(' ') }
}
