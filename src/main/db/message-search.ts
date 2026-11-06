import type Database from 'better-sqlite3'
import { STORED_TASK_NOTICE_PREFIX } from '@shared/synthetic-message'
import { parseArchiveIntent } from '@shared/archive-intent'
import {
  ftsMatchExpression,
  ftsPhraseExpression,
  isPhraseMatch,
  isWordPrefixMatch,
  messageSearchTerms,
  MESSAGE_SEARCH_LIMIT,
  orderMessageSearchResults,
  SNIPPET_MARK_CLOSE,
  SNIPPET_MARK_OPEN,
  type MessageSearchResult,
} from '@shared/message-search'
import { createMainLogger } from '../logger'

const log = createMainLogger('db:message-search')

export type SearchResult = MessageSearchResult

/**
 * Rows read by relevance before the phrase and recency order picks the
 * shown ones, so a phrase match just past the limit can still rise into it.
 */
const CANDIDATE_FACTOR = 4

/** Fallback scan page size: rows read by recency per round, filtered in JS. */
const FALLBACK_CHUNK_SIZE = 200
// ponytail: cap the fallback scan so an FTS outage on a huge database cannot
// scan forever looking for boundedLimit valid matches that may not exist.
const FALLBACK_MAX_CHUNKS = 20

export interface MessageSearchScope {
  /**
   * Only chats whose root project path is one of these, applied in SQL on
   * both the FTS and the fallback path, so it counts before the limit. Empty
   * finds nothing. Omitted searches every project (global search).
   */
  projectPaths?: readonly string[]
}

/** `AND <column> IN (?, ...)` and its parameters, or nothing when no scope is set. */
function projectScope(column: string, scope: MessageSearchScope): { sql: string; params: string[] } {
  if (!scope.projectPaths) return { sql: '', params: [] }
  return {
    sql: `AND ${column} IN (${scope.projectPaths.map(() => '?').join(',')})`,
    params: [...scope.projectPaths],
  }
}

export function searchMessagesInDatabase(
  database: Database.Database,
  query: string,
  limit = MESSAGE_SEARCH_LIMIT,
  scope: MessageSearchScope = {},
): SearchResult[] {
  const intent = parseArchiveIntent(query)
  const terms = messageSearchTerms(intent.query)
  const match = ftsMatchExpression(terms)
  if (!match) return []
  if (scope.projectPaths?.length === 0) return []
  const projects = projectScope('COALESCE(root.project_path, c.project_path)', scope)
  const boundedLimit = Math.max(1, Math.min(limit, MESSAGE_SEARCH_LIMIT))
  // A stored task notice is machine text, and a reload replaces it with the
  // transcript's copy when there is one, so a hit on it can name a row the
  // chat does not show.
  const notStoredNotice = `substr(m.id, 1, ${STORED_TASK_NOTICE_PREFIX.length}) != '${STORED_TASK_NOTICE_PREFIX}'`
  const archivedFilter = intent.includeArchived ? '' : 'AND COALESCE(root.archived, c.archived) = 0'
  const columns = `
        m.id as messageId,
        COALESCE(root.id, m.conversation_id) as conversationId,
        m.role,
        m.content,
        m.timestamp,
        COALESCE(root.title, c.title) as conversationTitle,
        COALESCE(root.project_path, c.project_path) as projectPath,
        COALESCE(root.agent_type, c.agent_type) as agentType,
        CASE WHEN root.id IS NOT NULL THEN root.worktree_path ELSE c.worktree_path END as worktreePath,
        CASE WHEN root.id IS NOT NULL THEN root.worktree_branch ELSE c.worktree_branch END as worktreeBranch,
        COALESCE(root.archived, c.archived) as archived`
  const joinsAndFilters = `
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN thread_sessions ts ON ts.claude_session_id = m.conversation_id
      LEFT JOIN conversations root ON root.id = ts.thread_id`
  const rowFilters = `
        AND COALESCE(root.sidebar_role, c.sidebar_role) = 'managed'
        AND COALESCE(root.agent_type, c.agent_type) != 'terminal'
        ${archivedFilter}
        ${projects.sql}
        AND ${notStoredNotice}`

  type Row = Omit<SearchResult, 'archived' | 'phraseMatch'> & { archived: number | null }
  let rows: Row[]
  try {
    const ftsRows = (expression: string) =>
      database
        .prepare(`
      SELECT ${columns},
        bm25(messages_fts) as rank,
        snippet(messages_fts, 0, '**', '**', '...', 40) as snippet,
        snippet(messages_fts, 0, ?, ?, '...', 40) as snippetMarked
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      ${joinsAndFilters}
      WHERE messages_fts MATCH ?
        ${rowFilters}
      ORDER BY rank
      LIMIT ?
    `)
        .all(
          SNIPPET_MARK_OPEN,
          SNIPPET_MARK_CLOSE,
          expression,
          ...projects.params,
          boundedLimit * CANDIDATE_FACTOR,
        ) as Row[]
    rows = ftsRows(match)
    // Words matched apart can fill the candidates before an adjacent match,
    // which ranks first, so phrase candidates are read on their own too.
    const phrase = ftsPhraseExpression(terms)
    if (phrase) {
      const seen = new Set(rows.map((row) => row.messageId))
      for (const row of ftsRows(phrase)) {
        if (!seen.has(row.messageId) && isPhraseMatch(row.content, terms)) rows.push(row)
      }
    }
  } catch (err) {
    // The terms are quoted letters and digits, so this is a broken or
    // missing index, not the query. A plain scan still finds the words.
    // Only the error code: an FTS message can quote the query.
    log.warn('FTS search failed, scanning messages instead', {
      terms: terms.length,
      code: (err as { code?: unknown } | null)?.code ?? 'unknown',
    })
    const likes = terms.map(() => 'AND m.content LIKE ?').join(' ')
    const likeParams = terms.map((term) => `%${term}%`)
    const fallbackPage = database.prepare(`
      SELECT ${columns},
        substr(m.content, max(1, instr(lower(m.content), lower(?)) - 20), 80) as snippet
      FROM messages m
      ${joinsAndFilters}
      WHERE 1 = 1 ${likes}
        ${rowFilters}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `)
    // LIKE finds a term anywhere in the row, including inside another word
    // ("cat" in "concatenate"), so a candidate page is filtered down to
    // FTS5's own word-prefix rule before it counts toward boundedLimit. Read
    // in bounded pages, oldest-ordered chunk last, so an interior-only match
    // among the newest rows cannot fill the limit and hide a real one further
    // back; FALLBACK_MAX_CHUNKS stops the scan once a very long run of
    // interior-only matches has been read.
    rows = []
    for (let chunk = 0; chunk < FALLBACK_MAX_CHUNKS && rows.length < boundedLimit; chunk++) {
      const page = fallbackPage.all(
        terms[0],
        ...likeParams,
        ...projects.params,
        FALLBACK_CHUNK_SIZE,
        chunk * FALLBACK_CHUNK_SIZE,
      ) as Row[]
      for (const row of page) {
        if (isWordPrefixMatch(row.content, terms)) {
          rows.push(row)
          if (rows.length >= boundedLimit) break
        }
      }
      if (page.length < FALLBACK_CHUNK_SIZE) break
    }
  }

  const results = rows.map((row): SearchResult => ({
    ...row,
    archived: Boolean(row.archived),
    phraseMatch: isPhraseMatch(row.content, terms),
  }))
  return orderMessageSearchResults(results).slice(0, boundedLimit)
}

export interface ChatTitleHit {
  conversationId: string
  title: string
  projectPath: string
  archived: boolean
}

/** Root chats read per title search, newest first, before the word rule filters them. */
const TITLE_CANDIDATES = 2000

/**
 * Root chats whose title holds every term as a word prefix, the rule the
 * message index applies to message text. Managed, non-terminal roots only,
 * under the same archive rule, inside `scope`. Newest first.
 */
export function searchChatTitlesInDatabase(
  database: Database.Database,
  query: string,
  scope: MessageSearchScope = {},
): ChatTitleHit[] {
  const intent = parseArchiveIntent(query)
  const terms = messageSearchTerms(intent.query)
  if (terms.length === 0 || scope.projectPaths?.length === 0) return []
  const projects = projectScope('c.project_path', scope)
  const rows = database
    .prepare(
      `SELECT c.id AS conversationId, c.title, c.project_path AS projectPath, c.archived
         FROM conversations c
        WHERE c.sidebar_role = 'managed' AND c.agent_type != 'terminal'
          ${intent.includeArchived ? '' : 'AND c.archived = 0'}
          ${projects.sql}
          AND NOT EXISTS (
            SELECT 1 FROM thread_sessions ts
             WHERE ts.claude_session_id = c.id AND ts.thread_id != c.id
          )
        ORDER BY c.updated_at DESC
        LIMIT ?`,
    )
    .all(...projects.params, TITLE_CANDIDATES) as Array<Omit<ChatTitleHit, 'archived'> & { archived: number }>
  return rows
    .filter((row) => isWordPrefixMatch(row.title ?? '', terms))
    .map((row) => ({ ...row, archived: row.archived === 1 }))
}
