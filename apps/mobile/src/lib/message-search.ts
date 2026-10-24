/**
 * Rules for the message search screen, ported from native Android
 * (`MessageSearchCoordinator.kt`, `MessageSearchPresentation.kt`).
 */
import type { MessageSearchResult } from '@shared/message-search'

export const SEARCH_DEBOUNCE_MS = 200
export const SEARCH_RESULT_LIMIT = 40
const MIN_QUERY_LENGTH = 2
const SNIPPET_MAX = 240

export interface MessageSearchRow {
  key: string
  title: string
  snippet: string
  /** "project · You", plus "Archived" for an archived chat. */
  metadata: string
  result: MessageSearchResult
}

/** The trimmed query to send, or null while it is too short to search. */
export function searchableQuery(query: string): string | null {
  const trimmed = query.trim()
  return trimmed.length >= MIN_QUERY_LENGTH ? trimmed : null
}

/** Drops the `**` match markers and the FTS ellipsis dots, folds whitespace, caps the length. */
export function cleanSnippet(value: string): string {
  const normalized = value
    .replaceAll('**', '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  return normalized.length <= SNIPPET_MAX ? normalized : `${normalized.slice(0, SNIPPET_MAX).trimEnd()}…`
}

export const SEARCH_NOT_READY = 'Machine is not ready. Retry search.'

/**
 * Android's search copy (`RpcFailure.searchMessage()`) for the transport's own
 * failures; an error the backend sent is shown as it is.
 */
export function searchErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('invoke timed out:')) return 'Search timed out. Retry.'
  if (message.startsWith('transport queue full:')) return 'Machine is busy. Retry search.'
  if (message === 'WebSocket closed') return 'Machine connection was lost. Retry search.'
  if (message === 'transport closed') return 'Machine connection changed. Retry search.'
  return message
}

function projectName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || path
  )
}

function roleLabel(role: string): string {
  switch (role.toLowerCase()) {
    case 'user':
      return 'You'
    case 'assistant':
      return 'Assistant'
    default:
      return role.charAt(0).toUpperCase() + role.slice(1)
  }
}

export function messageSearchRow(result: MessageSearchResult): MessageSearchRow {
  return {
    key: `${result.conversationId}:${result.messageId}`,
    title: result.conversationTitle.trim() || 'Untitled chat',
    snippet: cleanSnippet(result.snippet),
    metadata: [projectName(result.projectPath), roleLabel(result.role), result.archived ? 'Archived' : null]
      .filter(Boolean)
      .join(' · '),
    result,
  }
}
