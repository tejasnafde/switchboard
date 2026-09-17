/**
 * The durable half of an execution-root relocation.
 *
 * Two things are being pinned.
 *
 * 1. The REVISION is bumped in the same statement that moves the pointer.
 *    If a reader could observe a new path against an old revision, the
 *    optimistic-concurrency check is decorative: a second client holding the
 *    old revision would still be admitted.
 *
 * 2. Every accessor resolves through `resolveRootThreadId` FIRST. Claude
 *    rotates a chat's session id mid-conversation, the sidebar then surfaces
 *    the rotated id, and a raw `WHERE id = ?` silently writes to no row at
 *    all. CLAUDE.md records this trap being hit twice; `setConversationWorktree`
 *    is a third instance that was already live before this change.
 *
 * A stateful fake stands in for SQLite, driven by the real SQL our functions
 * issue, because the prebuilt better-sqlite3 targets Electron's ABI and will
 * not load under vitest. Same approach as conversation-rotation-fallback.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface Row {
  worktree_path?: string | null
  worktree_branch?: string | null
  execution_root_revision?: number | null
  project_path?: string
}

const threadSessions = new Map<string, string>()
const conversations = new Map<string, Row>()

vi.mock('better-sqlite3', () => {
  class FakeDb {
    pragma() {}
    exec() {}
    transaction(fn: (...args: unknown[]) => unknown) {
      return (...args: unknown[]) => fn(...args)
    }
    prepare(rawSql: string) {
      // Our SQL is written multi-line for readability; collapse it so the
      // fake matches the STATEMENT rather than its formatting.
      const sql = rawSql.replace(/\s+/g, ' ').trim()
      return {
        get: (...args: unknown[]) => {
          if (/SELECT thread_id FROM thread_sessions WHERE claude_session_id = \?/.test(sql)) {
            const threadId = threadSessions.get(args[0] as string)
            return threadId !== undefined ? { thread_id: threadId } : undefined
          }
          if (/SELECT worktree_path, worktree_branch, execution_root_revision, project_path FROM conversations WHERE id = \?/.test(sql)) {
            const row = conversations.get(args[0] as string)
            return row
              ? {
                worktree_path: row.worktree_path ?? null,
                worktree_branch: row.worktree_branch ?? null,
                execution_root_revision: row.execution_root_revision ?? null,
                project_path: row.project_path ?? null,
              }
              : undefined
          }
          return undefined
        },
        run: (...args: unknown[]) => {
          if (/UPDATE conversations SET worktree_path = \?, worktree_branch = \?, execution_root_revision =/.test(sql)) {
            const [path, branch, , id] = args as [string | null, string | null, number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.worktree_path = path
            row.worktree_branch = branch
            row.execution_root_revision = (row.execution_root_revision ?? 0) + 1
            return { changes: 1 }
          }
          if (/UPDATE conversations SET worktree_path = \?, worktree_branch = \?, updated_at = \? WHERE id = \?/.test(sql)) {
            const [path, branch, , id] = args as [string | null, string | null, number, string]
            const row = conversations.get(id)
            if (!row) return { changes: 0 }
            row.worktree_path = path
            row.worktree_branch = branch
            return { changes: 1 }
          }
          return { changes: 0 }
        },
        all: () => [],
      }
    }
  }
  return { default: FakeDb }
})

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sb-execution-root-db-test' } }))

const {
  getConversationExecutionRoot,
  commitConversationExecutionRoot,
  setConversationWorktree,
  recordThreadSession,
} = await import('../../src/main/db/database')

beforeEach(() => {
  threadSessions.clear()
  conversations.clear()
})

describe('getConversationExecutionRoot', () => {
  it('reads the stored pointer and revision', () => {
    conversations.set('c1', { project_path: '/repo/app', worktree_path: '/wt/a', worktree_branch: 'sb/a', execution_root_revision: 3 })
    expect(getConversationExecutionRoot('c1')).toMatchObject({
      worktreePath: '/wt/a',
      worktreeBranch: 'sb/a',
      revision: 3,
    })
  })

  it('reports revision 0 for a row written before the column existed', () => {
    conversations.set('c1', { project_path: '/repo/app', worktree_path: null, worktree_branch: null, execution_root_revision: null })
    expect(getConversationExecutionRoot('c1')?.revision).toBe(0)
  })

  it('returns null for an unknown conversation', () => {
    expect(getConversationExecutionRoot('nope')).toBeNull()
  })

  it('resolves a rotated Claude session id back to its root conversation', () => {
    conversations.set('agent_1', { project_path: '/repo/app', worktree_path: '/wt/a', worktree_branch: 'sb/a', execution_root_revision: 2 })
    threadSessions.set('uuid-rotated', 'agent_1')
    expect(getConversationExecutionRoot('uuid-rotated')?.revision).toBe(2)
  })
})

describe('commitConversationExecutionRoot', () => {
  it('moves the pointer and bumps the revision together', () => {
    conversations.set('c1', { project_path: '/repo/app', execution_root_revision: 0 })
    expect(commitConversationExecutionRoot('c1', '/wt/a', 'sb/a')).toBe(1)
    expect(conversations.get('c1')).toMatchObject({
      worktree_path: '/wt/a',
      worktree_branch: 'sb/a',
      execution_root_revision: 1,
    })
  })

  it('bumps from a null revision on a pre-migration row', () => {
    conversations.set('c1', { project_path: '/repo/app', execution_root_revision: null })
    expect(commitConversationExecutionRoot('c1', '/wt/a', 'sb/a')).toBe(1)
  })

  it('increments on every move, so two moves never share a revision', () => {
    conversations.set('c1', { project_path: '/repo/app', execution_root_revision: 0 })
    expect(commitConversationExecutionRoot('c1', '/wt/a', 'sb/a')).toBe(1)
    expect(commitConversationExecutionRoot('c1', '/wt/b', 'sb/b')).toBe(2)
  })

  it('bumps the revision when returning to the parent checkout', () => {
    conversations.set('c1', { project_path: '/repo/app', worktree_path: '/wt/a', worktree_branch: 'sb/a', execution_root_revision: 4 })
    expect(commitConversationExecutionRoot('c1', null, null)).toBe(5)
    expect(conversations.get('c1')?.worktree_path).toBeNull()
  })

  it('writes to the ROOT conversation when handed a rotated session id', () => {
    conversations.set('agent_1', { project_path: '/repo/app', execution_root_revision: 0 })
    threadSessions.set('uuid-rotated', 'agent_1')
    expect(commitConversationExecutionRoot('uuid-rotated', '/wt/a', 'sb/a')).toBe(1)
    expect(conversations.get('agent_1')).toMatchObject({ worktree_path: '/wt/a', execution_root_revision: 1 })
    expect(conversations.has('uuid-rotated')).toBe(false)
  })

  it('returns null rather than inventing a row when the conversation is gone', () => {
    expect(commitConversationExecutionRoot('nope', '/wt/a', 'sb/a')).toBeNull()
  })
})

describe('setConversationWorktree (legacy path)', () => {
  it('also resolves a rotated session id, instead of writing to nothing', () => {
    conversations.set('agent_1', { project_path: '/repo/app' })
    threadSessions.set('uuid-rotated', 'agent_1')
    setConversationWorktree('uuid-rotated', '/wt/a', 'sb/a')
    expect(conversations.get('agent_1')?.worktree_path).toBe('/wt/a')
  })
})

describe('recordThreadSession is still the mapping source', () => {
  it('exists so the rotation fallback has something to resolve through', () => {
    expect(typeof recordThreadSession).toBe('function')
  })
})
