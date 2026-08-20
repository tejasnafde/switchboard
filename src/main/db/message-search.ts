import type Database from 'better-sqlite3'

export interface SearchResult {
  messageId: string
  conversationId: string
  role: string
  content: string
  snippet: string
  conversationTitle: string
  projectPath: string
  agentType: string
  worktreePath: string | null
  worktreeBranch: string | null
}

export function searchMessagesInDatabase(
  database: Database.Database,
  query: string,
  limit = 50,
): SearchResult[] {
  const sanitized = query.replace(/['"]/g, ' ').trim()
  if (!sanitized) return []
  const boundedLimit = Math.max(1, Math.min(limit, 50))

  try {
    return database.prepare(`
      SELECT
        m.id as messageId,
        COALESCE(root.id, m.conversation_id) as conversationId,
        m.role,
        m.content,
        COALESCE(root.title, c.title) as conversationTitle,
        COALESCE(root.project_path, c.project_path) as projectPath,
        COALESCE(root.agent_type, c.agent_type) as agentType,
        CASE WHEN root.id IS NOT NULL THEN root.worktree_path ELSE c.worktree_path END as worktreePath,
        CASE WHEN root.id IS NOT NULL THEN root.worktree_branch ELSE c.worktree_branch END as worktreeBranch,
      snippet(messages_fts, 0, '**', '**', '...', 40) as snippet
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN thread_sessions ts ON ts.claude_session_id = m.conversation_id
      LEFT JOIN conversations root ON root.id = ts.thread_id
      WHERE messages_fts MATCH ?
        AND COALESCE(root.sidebar_role, c.sidebar_role) = 'managed'
        AND COALESCE(root.archived, c.archived) = 0
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, boundedLimit) as SearchResult[]
  } catch {
    return database.prepare(`
      SELECT
        m.id as messageId,
        COALESCE(root.id, m.conversation_id) as conversationId,
        m.role,
        m.content,
        substr(m.content, max(1, instr(lower(m.content), lower(?)) - 20), 80) as snippet,
        COALESCE(root.title, c.title) as conversationTitle,
        COALESCE(root.project_path, c.project_path) as projectPath,
        COALESCE(root.agent_type, c.agent_type) as agentType,
        CASE WHEN root.id IS NOT NULL THEN root.worktree_path ELSE c.worktree_path END as worktreePath,
        CASE WHEN root.id IS NOT NULL THEN root.worktree_branch ELSE c.worktree_branch END as worktreeBranch
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN thread_sessions ts ON ts.claude_session_id = m.conversation_id
      LEFT JOIN conversations root ON root.id = ts.thread_id
      WHERE m.content LIKE ?
        AND COALESCE(root.sidebar_role, c.sidebar_role) = 'managed'
        AND COALESCE(root.archived, c.archived) = 0
      LIMIT ?
    `).all(sanitized, `%${sanitized}%`, boundedLimit) as SearchResult[]
  }
}
