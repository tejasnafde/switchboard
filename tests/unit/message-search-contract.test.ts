import { describe, expect, it } from 'vitest'
import { searchMessagesInDatabase } from '../../src/main/db/message-search'

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
