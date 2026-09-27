/**
 * Chat ↔ PR links survive a provider session rotation, the same trap
 * `conversation-rotation-fallback.test.ts` guards for the other
 * per-conversation settings: Claude hands the chat a new session UUID after
 * the first turn and the sidebar surfaces it as the chat's id, so a link must
 * be read and written through `resolveRootThreadId`.
 *
 * Same approach as that file: better-sqlite3 cannot load under vitest, so a
 * small stateful fake stands in for `thread_sessions`,
 * `conversation_pull_requests` and `conversations`, driven by the SQL the
 * functions issue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const threadSessions = new Map<string, string>() // claude_session_id -> thread_id
const conversations = new Map<string, { title: string; agent_type: string; project_path: string; updated_at: number; archived: number }>()
interface LinkRow { conversation_id: string; host: string; owner: string; repo: string; number: number; source: string; linked_at: number; unlinked_at: number | null }
const links = new Map<string, LinkRow>()
const historyScans = new Map<string, number>() // conversation_id -> scanned_at
const key = (id: string, host: string, owner: string, repo: string, number: number) => `${id}|${host}|${owner}|${repo}|${number}`

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
          return undefined
        },
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT OR IGNORE INTO conversation_pull_requests')) {
            const [id, host, owner, repo, number, at] = args as [string, string, string, string, number, number]
            const k = key(id, host, owner, repo, number)
            if (links.has(k)) return { changes: 0 }
            links.set(k, { conversation_id: id, host, owner, repo, number, source: 'auto', linked_at: at, unlinked_at: null })
            return { changes: 1 }
          }
          if (sql.includes('INSERT INTO conversation_pull_requests') && sql.includes('ON CONFLICT')) {
            const [id, host, owner, repo, number, at] = args as [string, string, string, string, number, number]
            const k = key(id, host, owner, repo, number)
            const row = links.get(k)
            if (!row) {
              links.set(k, { conversation_id: id, host, owner, repo, number, source: 'manual', linked_at: at, unlinked_at: null })
              return { changes: 1 }
            }
            if (row.unlinked_at === null) return { changes: 0 }
            Object.assign(row, { unlinked_at: null, source: 'manual', linked_at: at })
            return { changes: 1 }
          }
          if (sql.includes('INSERT INTO conversation_pr_history_scans')) {
            historyScans.set(args[0] as string, args[1] as number)
            return { changes: 1 }
          }
          if (sql.includes('UPDATE conversation_pull_requests SET unlinked_at = ?')) {
            const [at, id, host, owner, repo, number] = args as [number, string, string, string, string, number]
            const row = links.get(key(id, host, owner, repo, number))
            if (!row || row.unlinked_at !== null) return { changes: 0 }
            row.unlinked_at = at
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
          if (sql.includes('LEFT JOIN conversation_pr_history_scans')) {
            return [...conversations.entries()]
              .filter(([id, c]) => !historyScans.has(id) && c.agent_type !== 'terminal')
              .filter(([id]) => ![...threadSessions.entries()].some(([sessionId, threadId]) => sessionId === id && threadId !== id))
              .sort(([, a], [, b]) => b.updated_at - a.updated_at)
              .slice(0, args[0] as number)
              .map(([id, c]) => ({ id, projectPath: c.project_path }))
          }
          if (sql.includes('FROM conversation_pull_requests WHERE conversation_id = ?')) {
            return [...links.values()]
              .filter((l) => l.conversation_id === args[0] && l.unlinked_at === null)
              .sort((a, b) => a.linked_at - b.linked_at)
          }
          if (sql.includes('FROM conversation_pull_requests l JOIN conversations c')) {
            const [host, owner, repo, number] = args as [string, string, string, number]
            return [...links.values()]
              .filter((l) => l.host === host && l.owner === owner && l.repo === repo && l.number === number && l.unlinked_at === null)
              .flatMap((l) => {
                const c = conversations.get(l.conversation_id)
                return c && !c.archived ? [{ id: l.conversation_id, ...c }] : []
              })
          }
          return []
        },
      }
    }
  }
  return { default: FakeDb }
})

const {
  linkConversationPullRequest,
  unlinkConversationPullRequest,
  listConversationPullRequests,
  listPullRequestChats,
  listUnscannedPullRequestHistoryScanTargets,
  markPullRequestHistoryScanned,
} = await import('../../src/main/db/database')

const PR = { host: 'github' as const, owner: 'TejasNafde', name: 'Switchboard', number: 612 }

beforeEach(() => {
  threadSessions.clear()
  conversations.clear()
  links.clear()
  historyScans.clear()
})

describe('PR links survive provider session rotation', () => {
  it('a link written through a rotated id lands on the root conversation and reads back from either id', () => {
    threadSessions.set('uuid-abc', 'agent_1')
    expect(linkConversationPullRequest('uuid-abc', PR, 'manual', 10)).toBe(true)
    expect([...links.values()].map((l) => l.conversation_id)).toEqual(['agent_1'])
    const expected = [{ ref: { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 612 }, source: 'manual', linkedAt: 10 }]
    expect(listConversationPullRequests('agent_1')).toEqual(expected)
    expect(listConversationPullRequests('uuid-abc')).toEqual(expected)
  })

  it('unlinking through a rotated id removes the root link', () => {
    threadSessions.set('uuid-abc', 'agent_1')
    linkConversationPullRequest('agent_1', PR, 'auto', 10)
    expect(unlinkConversationPullRequest('uuid-abc', PR, 20)).toBe(true)
    expect(listConversationPullRequests('agent_1')).toEqual([])
  })

  it('lists the chats of a PR with every id of their thread', () => {
    threadSessions.set('uuid-abc', 'agent_1')
    conversations.set('agent_1', { title: 'Sync backoff', agent_type: 'codex', project_path: '/p', updated_at: 5, archived: 0 })
    linkConversationPullRequest('uuid-abc', PR, 'manual', 10)
    expect(listPullRequestChats(PR)).toEqual([
      { id: 'agent_1', familyIds: ['agent_1', 'uuid-abc'], title: 'Sync backoff', agentType: 'codex', projectPath: '/p', updatedAt: 5 },
    ])
  })
})

describe('link once', () => {
  it('an automatic link is added once and reports no change after', () => {
    expect(linkConversationPullRequest('agent_1', PR, 'auto', 10)).toBe(true)
    expect(linkConversationPullRequest('agent_1', PR, 'auto', 11)).toBe(false)
    expect(listConversationPullRequests('agent_1')).toHaveLength(1)
  })

  it('an automatic link never revives one the user removed, but linking by hand does', () => {
    linkConversationPullRequest('agent_1', PR, 'auto', 10)
    unlinkConversationPullRequest('agent_1', PR, 20)
    expect(linkConversationPullRequest('agent_1', PR, 'auto', 30)).toBe(false)
    expect(listConversationPullRequests('agent_1')).toEqual([])
    expect(linkConversationPullRequest('agent_1', PR, 'manual', 40)).toBe(true)
    expect(listConversationPullRequests('agent_1')).toEqual([
      { ref: { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 612 }, source: 'manual', linkedAt: 40 },
    ])
  })
})

describe('history scan bookkeeping', () => {
  it('marks the root chat through a rotated id, so the chat is not listed again', () => {
    threadSessions.set('uuid-abc', 'agent_1')
    conversations.set('agent_1', { title: 'Review', agent_type: 'claude-code', project_path: '/p', updated_at: 5, archived: 0 })
    conversations.set('uuid-abc', { title: 'Review', agent_type: 'claude-code', project_path: '/p', updated_at: 6, archived: 0 })
    conversations.set('term_1', { title: 'Shell', agent_type: 'terminal', project_path: '/p', updated_at: 7, archived: 0 })
    expect(listUnscannedPullRequestHistoryScanTargets(10)).toEqual([{ id: 'agent_1', projectPath: '/p' }])
    markPullRequestHistoryScanned('uuid-abc', 10)
    expect([...historyScans.keys()]).toEqual(['agent_1'])
    expect(listUnscannedPullRequestHistoryScanTargets(10)).toEqual([])
  })
})
