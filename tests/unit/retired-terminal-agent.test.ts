import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import {
  migrate,
  getArchivedConversations,
  unarchiveConversation,
  createConversation,
  searchMessages,
  createKanbanCard,
  updateKanbanCard,
  setConversationProviderSelection,
} from '../../src/main/db/database'
import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter } from '../../src/main/provider/types'
import { projectManagedRootSessions } from '../../src/main/ipc/terminal-sessions'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sb-retired-terminal-test' } }))

describe('retired Terminal agent upgrade', () => {
  let db: ReturnType<typeof createMigratedDb>
  beforeEach(() => {
    db = createMigratedDb()
    db.prepare('INSERT INTO projects (path, name) VALUES (?, ?)').run('/repo', 'Repo')
    db.prepare(`INSERT INTO conversations (id, project_path, agent_type, title, sidebar_role, archived)
      VALUES (?, '/repo', ?, ?, 'managed', ?)`).run('agent_terminal', 'terminal', 'Old terminal', 0)
    db.prepare(`INSERT INTO conversations (id, project_path, agent_type, title, sidebar_role, archived)
      VALUES (?, '/repo', ?, ?, 'managed', ?)`).run('agent_claude', 'claude-code', 'Normal chat', 0)
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, timestamp)
      VALUES ('message', 'agent_terminal', 'user', 'Keep this history', 123)`).run()
    db.prepare(`INSERT INTO session_layouts (session_id, layout_json) VALUES ('agent_terminal', '{"rows":[]}')`).run()
  })

  it('archives legacy chats idempotently without losing history or changing active providers', () => {
    migrate(db)
    migrate(db)
    expect(db.prepare('SELECT agent_type, archived FROM conversations WHERE id = ?').get('agent_terminal')).toEqual({
      agent_type: 'terminal',
      archived: 1,
    })
    expect(getArchivedConversations()).toEqual([
      expect.objectContaining({ id: 'agent_terminal', title: 'Old terminal' }),
    ])
    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get('message')).toEqual({
      content: 'Keep this history',
    })
    expect(db.prepare('SELECT layout_json FROM session_layouts WHERE session_id = ?').get('agent_terminal')).toEqual({
      layout_json: '{"rows":[]}',
    })
    expect(db.prepare('SELECT archived FROM conversations WHERE id = ?').get('agent_claude')).toEqual({ archived: 0 })
    const rows = db.prepare('SELECT * FROM conversations').all() as Parameters<typeof projectManagedRootSessions>[0]
    expect(projectManagedRootSessions(rows).map((s) => s.id)).toEqual(['agent_claude'])
  })

  it('refuses to launch a provider for a retired chat opened by an older client', async () => {
    migrate(db)
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const host: BackendHost = {
      handle: (channel, fn) => {
        handlers.set(channel, fn as (...args: unknown[]) => unknown)
      },
      on: () => {},
      emit: () => {},
    }
    const startSession = vi.fn()
    const adapter = { provider: 'claude', startSession } as unknown as ProviderAdapter
    const registry = new ProviderRegistry(host, new Map([['claude', adapter]]))
    registry.registerIpcHandlers()
    try {
      await expect(
        handlers.get(ProviderChannels.START_SESSION)!({ threadId: 'agent_terminal', provider: 'claude', cwd: '/repo' }),
      ).rejects.toThrow('Terminal agent has been removed')
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      await registry.stopAll()
    }
  })

  it('refuses to turn a retired chat into a supported provider', () => {
    migrate(db)
    expect(() => setConversationProviderSelection('agent_terminal', 'claude-code', 'claude-code-default')).toThrow(
      'Terminal agent has been removed',
    )
    expect(db.prepare('SELECT agent_type FROM conversations WHERE id = ?').get('agent_terminal')).toEqual({
      agent_type: 'terminal',
    })
  })

  it('refuses new Terminal chats from an older client without creating a row', () => {
    expect(() => createConversation('new-terminal', '/repo', 'terminal')).toThrow('Terminal agent has been removed')
    expect(db.prepare('SELECT id FROM conversations WHERE id = ?').get('new-terminal')).toBeUndefined()
  })

  it('keeps linked Kanban cards movable while the retired chat stays archived', () => {
    migrate(db)
    createKanbanCard('card', { projectPath: '/repo', title: 'Legacy task', status: 'done' })
    updateKanbanCard('card', { conversationId: 'agent_terminal' })
    expect(updateKanbanCard('card', { status: 'backlog' })?.status).toBe('backlog')
    expect(db.prepare('SELECT archived FROM conversations WHERE id = ?').get('agent_terminal')).toEqual({ archived: 1 })
  })

  it.each([false, true])('excludes retired chats from archived message search, fallback=%s', (fallback) => {
    migrate(db)
    if (fallback) db.exec('DROP TABLE messages_fts')
    expect(searchMessages('archived Keep')).toEqual([])
    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get('message')).toEqual({
      content: 'Keep this history',
    })
  })

  it('refuses to restore a retired provider, including through a rotated id', () => {
    migrate(db)
    db.prepare('INSERT INTO thread_sessions (thread_id, claude_session_id) VALUES (?, ?)').run(
      'agent_terminal',
      'rotated-terminal',
    )
    expect(() => unarchiveConversation('rotated-terminal')).not.toThrow()
    expect(db.prepare('SELECT archived FROM conversations WHERE id = ?').get('agent_terminal')).toEqual({ archived: 1 })
  })
})
