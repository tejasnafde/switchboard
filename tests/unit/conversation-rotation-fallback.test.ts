/**
 * Regression test for the "provider instance resets to default when
 * bouncing between sidebar chats" bug.
 *
 * Claude's CLI/SDK rotates a chat's on-disk session id mid-conversation
 * (compaction, first-turn UUID assignment, etc.). Switchboard records that
 * rotation in `thread_sessions` (claude_session_id -> synthetic parent
 * thread_id) so title/worktree lookups can fall back to the parent - see
 * `getSyntheticParentMap` usage in `src/main/ipc/app.ts`. Provider instance
 * and runtime mode never got the same fallback: `getConversationProviderInstanceId`
 * queried `conversations WHERE id = ?` with the raw (possibly rotated) id, found
 * no row, and returned null - so the caller fell back to the default provider
 * instance instead of the one the user actually picked for that chat.
 *
 * Over a real better-sqlite3 (the prebuilt binary targets Electron's ABI and
 * won't load under vitest), same approach as projects-db.test.ts /
 * mark-read-db.test.ts: a small stateful fake standing in for the
 * `thread_sessions` and `conversations` tables, driven by the real SQL our
 * functions issue.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const threadSessions = new Map<string, string>() // claude_session_id -> thread_id
const conversations = new Map<string, {
  provider_instance_id?: string | null
  runtime_mode?: string | null
  model?: string | null
  archived?: number
  last_read_at?: number | null
}>()

vi.mock('better-sqlite3', () => {
  class FakeDb {
    pragma() {}
    exec() {}
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (/SELECT thread_id FROM thread_sessions WHERE claude_session_id = \?/.test(sql)) {
            const threadId = threadSessions.get(args[0] as string)
            return threadId !== undefined ? { thread_id: threadId } : undefined
          }
          if (/SELECT provider_instance_id FROM conversations WHERE id = \?/.test(sql)) {
            const row = conversations.get(args[0] as string)
            return row ? { provider_instance_id: row.provider_instance_id ?? null } : undefined
          }
          if (/SELECT runtime_mode FROM conversations WHERE id = \?/.test(sql)) {
            const row = conversations.get(args[0] as string)
            return row ? { runtime_mode: row.runtime_mode ?? null } : undefined
          }
          if (/SELECT model FROM conversations WHERE id = \?/.test(sql)) {
            const row = conversations.get(args[0] as string)
            return row ? { model: row.model ?? null } : undefined
          }
          if (/SELECT archived FROM conversations WHERE id = \?/.test(sql)) {
            const row = conversations.get(args[0] as string)
            return row ? { archived: row.archived ?? 0 } : undefined
          }
          if (/SELECT last_read_at FROM conversations WHERE id = \?/.test(sql)) {
            const row = conversations.get(args[0] as string)
            return row ? { last_read_at: row.last_read_at ?? null } : undefined
          }
          return undefined
        },
        run: (...args: unknown[]) => {
          // Real `UPDATE ... WHERE id = ?` is a no-op against a row that
          // doesn't exist yet - it must not insert one, or this fake would
          // hide a write silently landing on a nonexistent resolved-root row.
          if (/UPDATE conversations SET provider_instance_id = \?/.test(sql)) {
            const [instanceId, , id] = args as [string, number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.provider_instance_id = instanceId
            return { changes: 1 }
          }
          if (/UPDATE conversations SET runtime_mode = \?/.test(sql)) {
            const [mode, , id] = args as [string, number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.runtime_mode = mode
            return { changes: 1 }
          }
          if (/UPDATE conversations SET model = \?/.test(sql)) {
            const [model, , id] = args as [string, number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.model = model
            return { changes: 1 }
          }
          if (/UPDATE conversations SET archived = \?/.test(sql)) {
            const [archived, , id] = args as [number, number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.archived = archived
            return { changes: 1 }
          }
          if (/UPDATE conversations SET last_read_at = \?/.test(sql)) {
            const [at, id] = args as [number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.last_read_at = at
            return { changes: 1 }
          }
          return { changes: 0 }
        },
        all: (...args: unknown[]) => {
          if (/SELECT claude_session_id, recorded_at FROM thread_sessions WHERE thread_id = \?/.test(sql)) {
            return [...threadSessions.entries()]
              .filter(([, threadId]) => threadId === args[0])
              .map(([claudeSessionId]) => ({ claude_session_id: claudeSessionId, recorded_at: 1 }))
          }
          return []
        },
      }
    }
  }
  return { default: FakeDb }
})

const {
  getConversationProviderInstanceId,
  setConversationProviderInstanceId,
  getConversationRuntimeMode,
  setConversationRuntimeMode,
  getConversationModel,
  setConversationModel,
  archiveConversation,
  unarchiveConversation,
  isConversationArchived,
  setConversationLastRead,
  getConversationLastRead,
} = await import('../../src/main/db/database')

beforeEach(() => {
  threadSessions.clear()
  conversations.clear()
})

describe('provider instance survives Claude session-id rotation', () => {
  it('resolves a rotated UUID back to its synthetic parent when reading', () => {
    conversations.set('agent_123', { provider_instance_id: 'backend' })
    threadSessions.set('uuid-abc', 'agent_123') // rotation recorded by the 'session' event
    expect(getConversationProviderInstanceId('uuid-abc')).toBe('backend')
  })

  it('writes through a rotated UUID land on the synthetic parent row, not a new one', () => {
    conversations.set('agent_123', { provider_instance_id: 'backend' })
    threadSessions.set('uuid-abc', 'agent_123')
    setConversationProviderInstanceId('uuid-abc', 'pankaj')
    expect(conversations.get('agent_123')?.provider_instance_id).toBe('pankaj')
    expect(conversations.has('uuid-abc')).toBe(false)
  })

  it('is an unaffected passthrough when the id was never rotated', () => {
    conversations.set('agent_456', { provider_instance_id: 'aditya' })
    expect(getConversationProviderInstanceId('agent_456')).toBe('aditya')
  })

  it('returns null when neither the id nor its resolved root has a saved instance', () => {
    conversations.set('agent_789', {})
    expect(getConversationProviderInstanceId('agent_789')).toBeNull()
  })
})

describe('runtime mode survives Claude session-id rotation', () => {
  it('resolves a rotated UUID back to its synthetic parent when reading', () => {
    conversations.set('agent_123', { runtime_mode: 'full-access' })
    threadSessions.set('uuid-abc', 'agent_123')
    expect(getConversationRuntimeMode('uuid-abc')).toBe('full-access')
  })

  it('writes through a rotated UUID land on the synthetic parent row, not a new one', () => {
    conversations.set('agent_123', { runtime_mode: 'sandbox' })
    threadSessions.set('uuid-abc', 'agent_123')
    setConversationRuntimeMode('uuid-abc', 'plan')
    expect(conversations.get('agent_123')?.runtime_mode).toBe('plan')
    expect(conversations.has('uuid-abc')).toBe(false)
  })

  it('is an unaffected passthrough when the id was never rotated', () => {
    conversations.set('agent_456', { runtime_mode: 'plan' })
    expect(getConversationRuntimeMode('agent_456')).toBe('plan')
  })
})

describe('model pin survives Claude session-id rotation', () => {
  it('resolves a rotated UUID back to its synthetic parent when reading', () => {
    conversations.set('agent_123', { model: 'claude-opus-4' })
    threadSessions.set('uuid-abc', 'agent_123')
    expect(getConversationModel('uuid-abc')).toBe('claude-opus-4')
  })

  it('writes through a rotated UUID land on the synthetic parent row, not a new one', () => {
    conversations.set('agent_123', { model: 'claude-opus-4' })
    threadSessions.set('uuid-abc', 'agent_123')
    setConversationModel('uuid-abc', 'claude-sonnet-4.5')
    expect(conversations.get('agent_123')?.model).toBe('claude-sonnet-4.5')
    expect(conversations.has('uuid-abc')).toBe(false)
  })

  it('is an unaffected passthrough when the id was never rotated', () => {
    conversations.set('agent_456', { model: 'gpt-5-codex' })
    expect(getConversationModel('agent_456')).toBe('gpt-5-codex')
  })

  it('returns null when neither the id nor its resolved root has a saved model', () => {
    conversations.set('agent_789', {})
    expect(getConversationModel('agent_789')).toBeNull()
  })
})

describe('archive covers every id of a rotated thread', () => {
  it('archives the rotated row as well as the root, so the chat cannot reappear', () => {
    conversations.set('agent_123', {})
    conversations.set('uuid-abc', {})
    threadSessions.set('uuid-abc', 'agent_123')

    archiveConversation('uuid-abc')

    expect(conversations.get('agent_123')?.archived).toBe(1)
    expect(conversations.get('uuid-abc')?.archived).toBe(1)
    expect(isConversationArchived('uuid-abc')).toBe(true)
  })

  it('unarchives every id too', () => {
    conversations.set('agent_123', { archived: 1 })
    conversations.set('uuid-abc', { archived: 1 })
    threadSessions.set('uuid-abc', 'agent_123')

    unarchiveConversation('agent_123')

    expect(conversations.get('agent_123')?.archived).toBe(0)
    expect(conversations.get('uuid-abc')?.archived).toBe(0)
  })
})

describe('read state covers every id of a rotated thread', () => {
  it('stamps the rotated row as well as the root, so the badge clears once', () => {
    conversations.set('agent_123', {})
    conversations.set('uuid-abc', {})
    threadSessions.set('uuid-abc', 'agent_123')

    expect(setConversationLastRead('uuid-abc', 5000)).toBe(true)

    expect(conversations.get('agent_123')?.last_read_at).toBe(5000)
    expect(conversations.get('uuid-abc')?.last_read_at).toBe(5000)
    expect(getConversationLastRead('uuid-abc')).toBe(5000)
  })

  it('reports no change when the thread has no row at all', () => {
    expect(setConversationLastRead('ghost', 5000)).toBe(false)
  })
})
