import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { searchMessagesInDatabase } from '../../src/main/db/message-search'
import { storedTaskNoticeId } from '../../src/shared/synthetic-message'

describe('message search contract', () => {
  it('returns canonical root-thread routing metadata for a fragment hit', () => {
    let sql = ''
    let params: unknown[] = []
    const row = {
      messageId: 'message-1',
      conversationId: 'root-thread',
      role: 'assistant',
      content: 'The durable needle is here',
      snippet: 'The durable **needle** is here',
      conversationTitle: 'Repair image sync',
      projectPath: '/repo',
      agentType: 'codex',
      worktreePath: '/repo/.switchboard/worktrees/images',
      worktreeBranch: 'sb/images',
    }
    const database = {
      prepare(source: string) {
        sql = source
        return {
          all(...values: unknown[]) {
            params = values
            return [row]
          },
        }
      },
    }

    expect(searchMessagesInDatabase(database as never, 'needle', 500)).toEqual([row])
    expect(sql).toContain('COALESCE(root.id, m.conversation_id) as conversationId')
    expect(sql).toContain('COALESCE(root.title, c.title) as conversationTitle')
    expect(sql).toContain('COALESCE(root.project_path, c.project_path) as projectPath')
    expect(sql).toContain('COALESCE(root.agent_type, c.agent_type) as agentType')
    expect(sql).toContain('CASE WHEN root.id IS NOT NULL THEN root.worktree_path ELSE c.worktree_path END as worktreePath')
    expect(sql).toContain('CASE WHEN root.id IS NOT NULL THEN root.worktree_branch ELSE c.worktree_branch END as worktreeBranch')
    expect(sql).toMatch(/as worktreeBranch,\s+snippet\(messages_fts/)
    expect(sql).toContain("COALESCE(root.sidebar_role, c.sidebar_role) = 'managed'")
    expect(sql).toContain('COALESCE(root.archived, c.archived) = 0')
    expect(params).toEqual(['needle', 50])
  })
})

describe('message search over a real index', () => {
  it('leaves stored task notices out of the results', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, project_path TEXT, agent_type TEXT,
        worktree_path TEXT, worktree_branch TEXT, sidebar_role TEXT, archived INTEGER);
      CREATE TABLE thread_sessions (claude_session_id TEXT, thread_id TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT);
      CREATE VIRTUAL TABLE messages_fts USING fts5(content, conversation_id, role);
      INSERT INTO conversations VALUES ('t1', 'Build', '/repo', 'claude', NULL, NULL, 'managed', 0);
    `)
    const insert = (id: string, role: string, content: string) => {
      const { lastInsertRowid } = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(id, 't1', role, content)
      db.prepare('INSERT INTO messages_fts(rowid, content, conversation_id, role) VALUES (?, ?, ?, ?)').run(lastInsertRowid, content, 't1', role)
    }
    insert('a1', 'assistant', 'The build failed with exit code 2')
    insert(storedTaskNoticeId('t1', 'task_u1'), 'user', '<task-notification>\n<status>failed</status>\n<summary>Build failed</summary>\n</task-notification>')

    expect(searchMessagesInDatabase(db, 'failed').map((r) => r.messageId)).toEqual(['a1'])
    db.close()
  })
})
