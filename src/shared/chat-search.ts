/**
 * Go to chat: which chats a title search shows, and in what order. The desktop
 * dialog (Mod+P) and both phones' chat-list search boxes use these rules; the
 * Android port is `ChatSearch.kt`, and both run tests/fixtures/chat-search-cases.json.
 *
 * Titles and project names only, never message text (Search across chats does that).
 */

export interface ChatSearchItem {
  title: string
  projectName: string
  /** Last activity, epoch ms. Newest first inside every tier. */
  lastActivity: number
  archived?: boolean
}

export const RECENT_CHAT_COUNT = 5

const ARCHIVE_WORDS = new Set(['archive', 'archived'])

export interface ChatQuery {
  /** Lowercased, single-spaced, without the archive words. */
  needle: string
  includeArchived: boolean
}

/** The words "archive" / "archived" turn archived chats on and are not matched. */
export function parseChatQuery(raw: string): ChatQuery {
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean)
  const kept = words.filter((w) => !ARCHIVE_WORDS.has(w))
  return { needle: kept.join(' '), includeArchived: kept.length !== words.length }
}

/** 0 exact title, 1 title starts with, 2 title contains, 3 project name contains, -1 no match. */
function tier(item: ChatSearchItem, needle: string): number {
  if (needle === '') return 0
  const title = item.title.toLowerCase()
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  if (title.includes(needle)) return 2
  if (item.projectName.toLowerCase().includes(needle)) return 3
  return -1
}

/** The chats a query shows, best first. An empty query is every chat, newest first. */
export function rankChats<T extends ChatSearchItem>(items: readonly T[], raw: string): T[] {
  const { needle, includeArchived } = parseChatQuery(raw)
  return items
    .filter((item) => includeArchived || !item.archived)
    .map((item) => ({ item, tier: tier(item, needle) }))
    .filter((entry) => entry.tier >= 0)
    .sort((a, b) => a.tier - b.tier || b.item.lastActivity - a.item.lastActivity)
    .map((entry) => entry.item)
}

export interface ChatSearchSection<T> {
  /** null for a query's single ranked list. */
  heading: 'Recent' | 'All chats' | null
  items: T[]
}

/** No query: Recent (the newest 5), then All chats (the rest). A query, even the archive word alone: one ranked list. */
export function chatSearchSections<T extends ChatSearchItem>(items: readonly T[], raw: string): ChatSearchSection<T>[] {
  const ranked = rankChats(items, raw)
  if (raw.trim() !== '') return [{ heading: null, items: ranked }]
  return [
    { heading: 'Recent' as const, items: ranked.slice(0, RECENT_CHAT_COUNT) },
    { heading: 'All chats' as const, items: ranked.slice(RECENT_CHAT_COUNT) },
  ].filter((section) => section.items.length > 0)
}

/** Where the query matched the title, for highlighting, or null. */
export function titleMatchRange(title: string, raw: string): [number, number] | null {
  const { needle } = parseChatQuery(raw)
  if (needle === '') return null
  const start = title.toLowerCase().indexOf(needle)
  return start < 0 ? null : [start, start + needle.length]
}
